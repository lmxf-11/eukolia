/**
 * Augments `ImportMeta` with Vite's `glob` helper so the ported completion code
 * can lazily load the ~250 per-package macro/environment definition files
 * without a static 4.7 MB JSON module.
 *
 * Declared in the Eukolia source tree (rather than depending on `vite/client`)
 * because `tsconfig.json` does not list Vite's client types.
 */

interface ImportMetaGlobOptions {
  eager?: boolean
  import?: string
  query?: string
  as?: string
}

interface ImportMeta {
  glob<T = unknown>(
    pattern: string | string[],
    options?: ImportMetaGlobOptions
  ): Record<string, () => Promise<T>>
  glob<T = unknown>(pattern: string | string[], options: ImportMetaGlobOptions & { eager: true }): Record<string, T>
}
