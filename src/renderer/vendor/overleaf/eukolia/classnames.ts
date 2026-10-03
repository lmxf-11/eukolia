/**
 * Minimal `classnames` replacement, so the ported Overleaf components keep their
 * `classNames(...)` call sites without adding a dependency for one helper.
 * Supports the subset Overleaf uses: strings, falsy values, objects and arrays.
 */
type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | Record<string, unknown>
  | ClassValue[]

export default function classNames(...values: ClassValue[]): string {
  const out: string[] = []
  for (const value of values) {
    if (!value) continue
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(String(value))
    } else if (Array.isArray(value)) {
      const nested = classNames(...value)
      if (nested) out.push(nested)
    } else if (typeof value === 'object') {
      for (const [key, enabled] of Object.entries(value)) {
        if (enabled) out.push(key)
      }
    }
  }
  return out.join(' ')
}
