/**
 * Eukolia replacement for Overleaf's `import-overleaf-module.macro`.
 *
 * Overleaf compiles `importOverleafModules('someCollection')` at build time into
 * an array of `{ import: require(...) }` entries built from a webpack context
 * over a modules directory. Eukolia is a single application rather than a
 * white-labelled platform, so the macro is replaced by a plain, documented
 * runtime registry with the same call shape and the same return type.
 *
 * Registration API (call once, at module scope, from the Eukolia host):
 *
 * ```ts
 * import { registerOverleafModule } from '@/vendor/overleaf/eukolia/import-overleaf-modules'
 *
 * registerOverleafModule('sourceEditorVisualExtensions', {
 *   import: { id: 'bib', defaultVisual: true, getExtensions: () => [] },
 * })
 * ```
 */

export type OverleafModuleEntry<T = unknown> = { import: T }

const registry = new Map<string, OverleafModuleEntry[]>()

/**
 * Register a module entry for a collection name.
 *
 * Mirrors the shape produced by the Overleaf macro, so ported call sites such
 * as `importOverleafModules('sourceEditorVisualExtensions').map(item => item.import)` keep working.
 */
export function registerOverleafModule<T>(
  collection: string,
  entry: OverleafModuleEntry<T>
): void {
  const existing = registry.get(collection)
  if (existing) {
    existing.push(entry as OverleafModuleEntry)
  } else {
    registry.set(collection, [entry as OverleafModuleEntry])
  }
}

/** Remove every entry for a collection. Intended for tests. */
export function clearOverleafModules(collection?: string): void {
  if (collection === undefined) {
    registry.clear()
  } else {
    registry.delete(collection)
  }
}

/**
 * The Overleaf macro's runtime equivalent: the entries registered for a
 * collection, or an empty array when nothing registered (Overleaf's macro
 * returns an empty array for an empty modules directory).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function importOverleafModules<T = any>(
  collection: string
): OverleafModuleEntry<T>[] {
  return (registry.get(collection) ?? []) as OverleafModuleEntry<T>[]
}
