/**
 * Eukolia substitution for Overleaf's `@/vendor/overleaf/eukolia/os`.
 * Detects the host platform from the browser user agent, which in Electron is
 * the real operating system.
 */
const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent

export const isMac = /Mac|iPhone|iPad|iPod/.test(ua)
export const isWindows = /Windows/.test(ua)
export const isLinux = !isMac && !isWindows

/** `⌘` on macOS, `Ctrl` elsewhere. */
export const ctrlKey = isMac ? '\u2318' : 'Ctrl'
