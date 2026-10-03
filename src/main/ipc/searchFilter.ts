/**
 * Eukolia — deciding which files a project search reads.
 *
 * The search panel offers an `include` filter written as globs (`*.tex`,
 * `*.md`, `chapters/*.tex`). This is the predicate behind it, kept in its own
 * module — with no Electron and no filesystem — so the rule can be tested
 * directly rather than through a running search.
 *
 * It used to be inlined in `fsHandler` and hand-rolled, which produced three
 * behaviours that were each wrong in a way the UI could not explain:
 *
 *  * a bare `*` matched nothing, because the code took the branch for a `*.`
 *    prefix, stripped the star and asked whether the path ended in `.`. So the
 *    *broadest possible* filter returned zero files — asking to search
 *    everything searched nothing;
 *  * any pattern containing a separator (`chapters/*.tex`) never matched,
 *    because it was tested as a substring of an absolute path;
 *  * a bare word (`chapter`) matched anywhere in the path, so it silently
 *    behaved like a substring search over directory names too.
 *
 * All three are the same mistake: treating a glob as a string suffix or
 * substring. The real matcher already existed in the codebase
 * (`vendor/latex-workshop/fs/glob`), so this module decides *which* patterns to
 * hand it and in what order, and owns the comma-separated list syntax.
 */

import { globMatches } from '../../renderer/vendor/latex-workshop/fs/glob';

/** Splits a comma-separated filter into trimmed, non-empty globs. */
export function splitPatterns(filter: string | undefined): string[] {
  if (!filter) return [];
  return filter
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

/**
 * True when `filePath` should be searched.
 *
 * `include` empty means every file, not none: an empty filter is how a user asks
 * for everything, and reading it as "match nothing" would make clearing the box
 * look like a broken search.
 */
export function matchesSearchFilter(
  filePath: string,
  include: string | undefined,
  exclude: string | undefined
): boolean {
  const normalized = filePath.replace(/\\/g, '/');

  const includes = splitPatterns(include);
  if (includes.length > 0 && !includes.some((pattern) => globMatches(pattern, normalized))) {
    return false;
  }

  const excludes = splitPatterns(exclude);
  if (excludes.some((pattern) => globMatches(pattern, normalized))) return false;

  return true;
}
