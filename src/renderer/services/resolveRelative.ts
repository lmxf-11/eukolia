/**
 * LaTeX path resolution.
 *
 * A leaf module on purpose: resolving `\input{...}` is needed by the workspace
 * service (which reads the files a document includes) and by root detection
 * (which decides which file is the root from the same commands), and those two
 * import each other's modules for other reasons. Keeping the pure path helper
 * here is what stops `services/workspace.ts` and `services/instance.ts` from
 * forming a cycle — a cycle that cost the test suite its ability to construct
 * `WorkspaceService` at all, because the class was still undefined when the
 * module that instantiates it ran.
 *
 * Instructions.md §41 (root detection), §29 (project awareness).
 */

/** Resolves a LaTeX-relative path, adding a `.tex` extension when absent. */
export function resolveRelative(fromFile: string, target: string): string {
  const windows = fromFile.includes('\\');
  const directory = fromFile.replace(/[\\/][^\\/]*$/, '').replace(/\\/g, '/');
  const parts = `${directory}/${target.replace(/\\/g, '/')}`.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  let joined = stack.join('/');
  if (!/\.[a-z0-9]+$/i.test(joined)) joined += '.tex';
  return windows ? joined.replace(/\//g, '\\') : joined;
}
