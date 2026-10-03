/**
 * Eukolia — the directory a build looks for its tools in.
 *
 * A TeX distribution is not always on the `PATH` the application was started
 * with: a MiKTeX install that has just been added, a TeX Live bin directory
 * outside the default tree, or a portable distribution on another drive. The
 * `advanced.texPath` setting is where a user says so, and this is what turns it
 * into something a spawn can use.
 *
 * The directory is *prepended*, not substituted: the tools a build needs are not
 * all TeX (`latexmk` is a Perl script on some installations, and MiKTeX's own
 * helpers live outside its bin directory), so the system `PATH` is kept and the
 * configured directory is searched first. An empty setting is the identity,
 * which is what makes this a no-op on a machine that never needed it.
 *
 * Windows spells the variable `Path` rather than `PATH`, and `process.env` keeps
 * whichever spelling it was given, so the lookup is case-insensitive and the
 * existing spelling is the one rewritten: a second `PATH` entry would be ignored
 * by the child's own environment handling, and a build that cannot find `latexmk`
 * because the variable was added twice is a very hard thing to diagnose.
 */

/** The environment variable that holds the executable search path. */
export function pathVariableName(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

/**
 * `env` with `directory` searched first, or `env` itself when there is nothing
 * to add.
 *
 * The directory is used as given rather than checked: a `PATH` entry that is not
 * a directory is skipped by the operating system, and refusing to add one would
 * turn a typo into a silent fall back to a *different* TeX installation — which
 * is the failure this setting exists to avoid.
 */
export function withToolPath(
  env: Record<string, string | undefined>,
  directory: string | undefined | null
): Record<string, string | undefined> {
  const trimmed = (directory ?? '').trim();
  if (!trimmed) return env;
  const key = pathVariableName(env);
  const existing = env[key] ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  return { ...env, [key]: existing ? `${trimmed}${separator}${existing}` : trimmed };
}
