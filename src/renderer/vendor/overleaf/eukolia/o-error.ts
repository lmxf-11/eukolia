/**
 * Eukolia substitution for Overleaf's `@/utils/o-error` (`@/vendor/overleaf/eukolia/o-error`).
 *
 * `OError` is used in the ported tree only to raise descriptive internal
 * errors, so a small `Error` subclass with `.withInfo()` reproduces the surface
 * that is actually exercised.
 */
export default class OError extends Error {
  public readonly info: Record<string, unknown>

  constructor(message: string, info: Record<string, unknown> = {}) {
    super(message)
    this.name = 'OError'
    this.info = info
  }

  withInfo(info: Record<string, unknown>): this {
    Object.assign(this.info, info)
    return this
  }
}
