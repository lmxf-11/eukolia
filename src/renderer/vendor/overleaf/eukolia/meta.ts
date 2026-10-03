/**
 * Eukolia substitution for Overleaf's `@/vendor/overleaf/eukolia/meta`.
 *
 * Overleaf bakes a `window.meta` blob into the page from server-side settings.
 * Eukolia is a desktop application, so the same keys are supplied from a plain
 * in-memory record that the application shell can populate.
 */

type Meta = Record<string, unknown>

const defaultMeta = (): Meta => ({
  'ol-ExposedSettings': {
    validRootDocExtensions: ['tex', 'ltx'],
  },
  'ol-editorThemes': [],
  'ol-legacyEditorThemes': [],
})

let meta: Meta =
  typeof window !== 'undefined' && (window as { meta?: Meta }).meta
    ? ((window as { meta?: Meta }).meta as Meta)
    : defaultMeta()

export function setMeta(values: Meta): void {
  meta = { ...meta, ...values }
}

// The meta blob is untyped by nature; any is the honest default here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function getMeta<T = any>(key: string): T {
  return meta[key] as T
}
