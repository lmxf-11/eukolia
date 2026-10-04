/**
 * Eukolia — previews for the Mathematical Symbols panel.
 *
 * Two kinds of preview, and the rule that decides between them is the whole of
 * this module.
 *
 * **A glyph, when the glyph is faithful *and drawable*.** Most catalog entries
 * carry the Unicode character the symbol draws. Showing the character is better
 * than showing `\alpha`: it is what the user is looking for, and it costs
 * nothing. But "carries a character" and "this machine can draw it" are
 * different facts. The catalog was generated from MathJax's tables, which cover
 * Unicode mathematics far beyond what any system font has — `\bigboxplus`,
 * `\nhVvert`, `\varhexagon` and a thousand more draw as `.notdef` boxes on a
 * machine without a full mathematics font, and a grid of empty boxes is worse
 * than a grid of commands. So the panel *asks the browser* whether it can draw
 * the character, once per character, and falls back to the command where it
 * cannot. `MathematicalSymbols.md` §3 asks for exactly this: "use a textual
 * command when no reliable glyph exists".
 *
 * **Typeset mathematics, for one entry at a time.** A template has no glyph —
 * a fraction is not a character — and its preview has to be drawn. That is the
 * only thing in this panel that touches MathJax, and it touches it for the
 * single focused entry, never for the grid. §10: "Do not typeset the complete
 * catalog on panel open … lazily render only visible complex templates/custom
 * macros".
 *
 * Both paths are cached and both are cancellable. The cache key carries the
 * entry id, the rendering size and the source text, so a request that arrives
 * after the user has moved on cannot install itself over a newer one — the
 * request carries a token and a stale one is dropped rather than rendered.
 */

import { mathJaxService } from '../math/mathjaxService'
import type { MathSymbolEntry } from './types'

/**
 * The font stack glyph previews are drawn in.
 *
 * The bundled `public/mathjax/fonts` are MathJax's SVG font *modules*, not a
 * Unicode font, so there is no shipped face to point at — which is exactly why
 * `canDrawGlyph` exists rather than a promise that the stack is complete. What
 * the stack does is prefer the real mathematics fonts in the order a desktop
 * has them, then fall through to the system's symbol coverage, then to the
 * serif face that at least draws Greek and the common operators.
 */
export const MATH_GLYPH_FONT_STACK =
  '"Cambria Math", "STIX Two Math", "Latin Modern Math", "XITS Math", "Asana Math", "Noto Sans Math", "DejaVu Sans", "Segoe UI Symbol", "Apple Symbols", serif'

/**
 * A character no font draws, used as the measure of "missing".
 *
 * `U+FFFF` is a permanent noncharacter: no font maps it to a glyph, so
 * everything that has a glyph is wider or differently shaped than it, and a
 * character the font lacks measures exactly like it.
 */
const MISSING = '\uFFFF'

let measureCanvas: HTMLCanvasElement | null = null
const glyphSupport = new Map<string, boolean>()

/**
 * Whether this environment can draw a character.
 *
 * Measured rather than assumed. The canvas is created once and never attached,
 * and the answer is memoised per character, so a grid of a few hundred cells
 * costs a few hundred `measureText` calls on first paint and nothing after.
 *
 * A renderer without a canvas — a jsdom test, a worker — answers `true`, which
 * keeps the *catalog* behaviour (show the glyph the catalog says exists) rather
 * than degrading every cell to a command because the measuring instrument is
 * absent.
 */
export function canDrawGlyph(glyph: string): boolean {
  if (glyph.length === 0) return false
  const cached = glyphSupport.get(glyph)
  if (cached !== undefined) return cached

  if (typeof document === 'undefined') return true
  try {
    if (!measureCanvas) {
      measureCanvas = document.createElement('canvas')
    }
    const context = measureCanvas.getContext?.('2d')
    if (!context) return true

    context.font = `19px ${MATH_GLYPH_FONT_STACK}`
    const missing = context.measureText(MISSING).width
    const drawn = context.measureText(glyph).width
    // Width alone is not quite enough: an em-dash and a missing glyph can
    // measure the same in a font that draws nothing for either. Comparing
    // against a second unmapped character catches the case where the browser
    // substitutes a visible fallback for one but not the other.
    const drawnToo = context.measureText('\uFFFE').width
    const supported = drawn !== missing || missing !== drawnToo
    glyphSupport.set(glyph, supported)
    return supported
  } catch {
    /*
     * A renderer with a canvas element but no 2-D context — jsdom, a headless
     * test — answers `true`, which keeps the *catalog's* behaviour (show the
     * glyph the catalog says exists) rather than degrading every cell to a
     * command because the measuring instrument is missing.
     */
    return true
  }
}

/** How a preview is drawn, for the cell and the details pane to switch on. */
export type SymbolPreviewKind = 'glyph' | 'command' | 'math'

export interface SymbolPreview {
  readonly kind: SymbolPreviewKind
  /** The character, when `kind` is `glyph`. */
  readonly glyph: string | null
  /** The code to show, when `kind` is `command`. */
  readonly command: string
  /** Serialized SVG, when `kind` is `math`. */
  readonly svg: string | null
  /** A short sentence when the preview could not be drawn. */
  readonly error: string | null
}

/**
 * The preview for an entry, synchronously, where one is possible.
 *
 * Returns `'math'` with no SVG for an entry that needs typesetting: the caller
 * then asks `typesetPreview`, which is the asynchronous half. Splitting them
 * this way is what lets the grid render every cell without ever awaiting
 * anything — a cell that needs mathematics shows its command until the details
 * pane draws it.
 */
export function symbolPreview(entry: MathSymbolEntry): SymbolPreview {
  const command = entry.variants[0]?.command ?? entry.name
  if (entry.preview === 'glyph' && entry.glyph && canDrawGlyph(entry.glyph)) {
    return { kind: 'glyph', glyph: entry.glyph, command, svg: null, error: null }
  }
  if (entry.preview === 'math' && entry.previewSource) {
    return { kind: 'math', glyph: null, command, svg: null, error: null }
  }
  return { kind: 'command', glyph: null, command, svg: null, error: null }
}

/* ------------------------------------------------------------------ *
 * Typeset previews
 * ------------------------------------------------------------------ */

/** How many typeset previews are kept. Small on purpose: the panel shows one. */
const PREVIEW_CACHE_LIMIT = 64

interface CachedPreview {
  readonly svg: string
  readonly error: string | null
}

const previewCache = new Map<string, CachedPreview>()

/** The most recent request, so a slow render cannot install itself late. */
let latestRequest = 0

const keyFor = (source: string, em: number): string => `${em}\u0000${source}`

function remember(key: string, value: CachedPreview): void {
  previewCache.delete(key)
  previewCache.set(key, value)
  while (previewCache.size > PREVIEW_CACHE_LIMIT) {
    const oldest = previewCache.keys().next()
    if (oldest.done) break
    previewCache.delete(oldest.value)
  }
}

/**
 * Typesets an entry's preview, or returns the cached result.
 *
 * The `em` size is part of the key, so a font-size change re-renders rather than
 * serving a preview drawn at the wrong scale — the same rule the editor's own
 * render cache follows.
 *
 * A stale request resolves to `null` rather than to its own result: the panel
 * asked for something else after this call started, and drawing the older
 * answer would put the wrong symbol in the details pane.
 */
export async function typesetPreview(
  entry: MathSymbolEntry,
  em = 20
): Promise<SymbolPreview | null> {
  const source = entry.previewSource
  const command = entry.variants[0]?.command ?? entry.name
  if (!source) return symbolPreview(entry)

  const key = keyFor(source, em)
  const cached = previewCache.get(key)
  if (cached) {
    return { kind: 'math', glyph: null, command, svg: cached.svg, error: cached.error }
  }

  const token = ++latestRequest
  try {
    const result = await mathJaxService.typeset(source, { display: false, em })
    if (token !== latestRequest) return null
    const value: CachedPreview = {
      svg: result.error ? '' : result.svg,
      error: result.error ?? null
    }
    remember(key, value)
    return { kind: 'math', glyph: null, command, svg: value.svg, error: value.error }
  } catch (error) {
    if (token !== latestRequest) return null
    // A preview that will not draw must not hide an insertable symbol: the
    // command is shown instead and the reason is carried alongside it.
    const message = error instanceof Error ? error.message : 'the preview could not be drawn'
    remember(key, { svg: '', error: message })
    return { kind: 'math', glyph: null, command, svg: '', error: message }
  }
}

/** Empties the preview cache. Used by tests and on a theme change. */
export function clearPreviewCache(): void {
  previewCache.clear()
}

/** The number of cached typeset previews, for the panel's tests. */
export function previewCacheSize(): number {
  return previewCache.size
}
