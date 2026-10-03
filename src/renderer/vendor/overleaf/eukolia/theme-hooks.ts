/**
 * Eukolia substitution for Overleaf's `@/vendor/overleaf/eukolia/theme-hooks`.
 * Overleaf reads the active theme from its React context; Eukolia's editor is
 * told the theme by its host, so a plain module-level store with a subscription
 * is enough.
 */

export type ActiveOverallTheme = 'light' | 'dark'

let activeTheme: ActiveOverallTheme = 'dark'
const listeners = new Set<(theme: ActiveOverallTheme) => void>()

export function setActiveOverallTheme(theme: ActiveOverallTheme): void {
  if (activeTheme === theme) return
  activeTheme = theme
  for (const listener of listeners) listener(theme)
}

export function getActiveOverallTheme(): ActiveOverallTheme {
  return activeTheme
}

export function subscribeActiveOverallTheme(
  listener: (theme: ActiveOverallTheme) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
