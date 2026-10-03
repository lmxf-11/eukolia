/**
 * Eukolia substitution for Overleaf's `@/vendor/overleaf/eukolia/debugging`.
 *
 * Ported from References/overleaf-main/services/web/frontend/js/utils/debugging.ts
 * (AGPL-3.0, (c) Overleaf). Modified for Eukolia: the `debug` query-string flag
 * is replaced by an explicit toggle, because the Eukolia renderer is not
 * routinely opened with a query string, and `window` may be absent in tests.
 */

export type DebugConsole = {
  debug(...data: unknown[]): void
  log(...data: unknown[]): void
  warn(...data: unknown[]): void
  error(...data: unknown[]): void
}

const hasWindow = typeof window !== 'undefined'

/** Toggled by `setDebugging` / the `eukolia:debug` localStorage flag. */
let debugEnabled = false

if (hasWindow) {
  try {
    debugEnabled =
      window.location.search.includes('debug=true') ||
      window.localStorage.getItem('eukolia:debug') === 'true'
  } catch {
    debugEnabled = false
  }
}

export const setDebugging = (value: boolean): void => {
  debugEnabled = value
}

export const debugging = debugEnabled

export const debugConsole: DebugConsole = {
  debug(...data: unknown[]) {
    if (debugEnabled) {
      console.debug(...data)
    }
  },
  log(...data: unknown[]) {
    if (debugEnabled) {
      console.log(...data)
    }
  },
  warn: console.warn.bind(console),
  error: console.error.bind(console),
}
