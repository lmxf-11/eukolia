/**
 * Eukolia — control-sequence names, spelled one way.
 *
 * TeX command names are case-sensitive and the leading backslash is part of how
 * they are *written*, not part of the name. Every layer of this feature has an
 * opinion about which of the two it is holding — the catalog keys variants by
 * the full `\command`, `projectIndex` keys macros by whichever spelling the
 * declaration used, and the search box accepts either — so the two operations
 * that convert between them live here rather than being re-spelled at each call
 * site.
 *
 * This is a small module on purpose. `projectMacros.ts` grew its own `bareName`
 * for the same reason and records why: comparing two names that differ only by a
 * backslash is how a lookup that should have found the definition in front of it
 * finds nothing, and quietly resolves the wrong thing.
 */

/** A command's name without its leading backslash. */
export const bareCommand = (name: string): string => name.replace(/^\\/, '')

/** A command's name with exactly one leading backslash. */
export const spellCommand = (name: string): string => `\\${bareCommand(name)}`

/** Whether a command name is a plain control word — letters only. */
export const isControlWord = (name: string): boolean => /^\\?[A-Za-z]+$/.test(name)
