/**
 * Eukolia Visual Mode — caret appearance.
 *
 * Code Mode configures the caret through Monaco's `editor.cursorBlinking` and
 * `editor.smoothCaret`. Visual Mode is the same editor with decorations painted
 * on, so it reads the same two settings and reproduces the same five
 * behaviours:
 *
 *   `solid`  the caret never blinks
 *   `blink`  a hard on/off blink (Monaco's default)
 *   `smooth` a fade out and back in
 *   `phase`  the same fade, offset half a cycle, so a caret at rest is faint
 *   `expand` the caret collapses to a point and grows back
 *
 * The ported `draw-selection.ts` supplies the machinery: like CodeMirror's own
 * `drawSelection`, it alternates the cursor layer's inline `style.animationName`
 * between `cm-blink` and `cm-blink2` on every selection change, purely to
 * *restart* the animation without a style recomputation. It deliberately does
 * not choose an animation — that is the stylesheet's job, and
 * `visual-editor.css` defines what each name means under each
 * `data-caret-blinking` value. Restarting an animation that resolves to `none`
 * is a no-op, which is exactly what `solid` needs.
 *
 * This module's job is therefore only to say *which* appearance is active: it
 * marks the editor and the cursor layer with `data-` attributes, and gives the
 * layer its starting `animationName` (CodeMirror's own `drawSelection` writes
 * that property from `mount`, and the vendored copy omits the call, so the
 * layer would otherwise start unanimated until the first selection change).
 *
 * `editor.smoothCaret` is Monaco's `cursorSmoothCaretAnimation`: the caret
 * travels to its new line instead of teleporting. CodeMirror draws the caret in
 * its own absolutely-positioned layer, so a transform transition on the markers
 * gives the same effect without touching the document or the selection.
 *
 * Keeping the rules in the app stylesheet rather than in a CodeMirror theme is
 * deliberate: CodeMirror mounts its generated stylesheet as the *first* child of
 * `<head>` (see the note at the top of `visual-editor.css`), so a theme here
 * would be competing with the ported Overleaf theme at equal specificity.
 */

import type { Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

/** Monaco's `editor.cursorBlinking` values, in the same order. */
export const CURSOR_BLINKING_STYLES = [
  'blink',
  'smooth',
  'phase',
  'expand',
  'solid',
] as const

export type CursorBlinking = (typeof CURSOR_BLINKING_STYLES)[number]

/** Monaco's own default for an unset or unknown `cursorBlinking`. */
export const DEFAULT_CURSOR_BLINKING: CursorBlinking = 'blink'

export const normalizeCursorBlinking = (value: string): CursorBlinking =>
  (CURSOR_BLINKING_STYLES as readonly string[]).includes(value)
    ? (value as CursorBlinking)
    : DEFAULT_CURSOR_BLINKING

export interface CaretAppearanceOptions {
  /** `editor.cursorBlinking`. */
  cursorBlinking: string
  /** `editor.smoothCaret`. */
  smoothCaret: boolean
}

/**
 * The `animationName` the cursor layer starts with.
 *
 * `draw-selection.ts` writes this same property on every selection change, so
 * these two names are the only ones that can ever be active for a blinking
 * caret. For `solid` the layer starts at `none` and stays there: the restart
 * toggle's first write sets `cm-blink`, which `visual-editor.css` resolves to
 * `animation: none` in that mode.
 */
export const caretAnimationName = (cursorBlinking: string): string =>
  normalizeCursorBlinking(cursorBlinking) === 'solid' ? 'none' : 'cm-blink'

/**
 * The `data-` attributes the stylesheet keys off, and that tests can assert.
 *
 * The caret's *colour* is the other half of its appearance. It is not here,
 * because it follows the editing context rather than a setting: mathematics is
 * edited with a caret of its own colour, and `editor/mathContext.ts`
 * (`data-caret-math`) is what reports which context is active.
 */
export const caretDataAttributes = (
  options: CaretAppearanceOptions
): Record<string, string> => {
  const blinking = normalizeCursorBlinking(options.cursorBlinking)
  return {
    'data-caret-blinking': blinking,
    'data-caret-smooth': options.smoothCaret ? 'on' : 'off',
  }
}

/** The cursor layer, which is where CodeMirror puts the blink animation. */
const cursorLayer = (view: EditorView): HTMLElement | null =>
  view.scrollDOM.querySelector<HTMLElement>('.cm-cursorLayer')

/**
 * Applies `editor.cursorBlinking` and `editor.smoothCaret` to a CodeMirror
 * editor.
 */
export const caretAppearance = (
  options: CaretAppearanceOptions
): Extension => {
  const attributes = caretDataAttributes(options)
  const animationName = caretAnimationName(options.cursorBlinking)

  /**
   * The layer is created lazily — by the first measurement — so its starting
   * `animationName` cannot be set by a plain extension. This plugin runs after
   * every update and on mount, which is the earliest point the element exists.
   *
   * It only ever fills the property in when it is empty: once
   * `draw-selection.ts` has written a name of its own, that name is the restart
   * toggle's, and overwriting it would defeat the toggle.
   */
  const cursorLayerAnimation = ViewPlugin.define(view => {
    const apply = () => {
      const layer = cursorLayer(view)
      if (layer && !layer.style.animationName) {
        layer.style.animationName = animationName
      }
    }
    apply()
    return { update: apply }
  })

  return [
    EditorView.editorAttributes.of(attributes),
    cursorLayerAnimation,
  ]
}
