/**
 * Eukolia substitution for the PDF-preview hooks the ported editor reaches for
 * (`@/vendor/overleaf/eukolia/pdf-preview`,
 * `@/vendor/overleaf/eukolia/pdf-preview`).
 *
 * Eukolia compiles through its own compiler service; the editor only needs to
 * ask for a compile, and (for embedded PDF figures) to render page 1 of a PDF.
 * Both are provided by the `EukoliaEditorScope`.
 */

export interface PdfPageRenderRequest {
  /** URL or `file://` path of the PDF. */
  url: string
  canvas: HTMLCanvasElement
  /** Target width in CSS pixels; height follows the page aspect ratio. */
  width?: number
}

/**
 * Starts a compile of the active project. Supplied by the Eukolia host.
 * Returns the trigger that was used, for logging/tests.
 */
/**
 * Requests a compile and reports whether one was actually requested, which is
 * what the ported table generator tests: `if (startCompileKeypress(event))`.
 */
export function startCompileKeypress(_event?: unknown): boolean {
  if (!compileStarter) return false
  startCompile('keypress')
  return true
}

export type CompileTrigger = 'keypress' | 'save' | 'manual'

type CompileStarter = (trigger: CompileTrigger) => void

let compileStarter: CompileStarter | null = null

/** Installed by the Eukolia host so editor extensions can request a compile. */
export function setCompileStarter(starter: CompileStarter | null): void {
  compileStarter = starter
}

export function startCompile(trigger: CompileTrigger): void {
  compileStarter?.(trigger)
}

export function canCompile(): boolean {
  return compileStarter !== null
}
