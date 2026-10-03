/**
 * Eukolia substitution for Overleaf's `@/vendor/overleaf/eukolia/styles`.
 *
 * Overleaf maps user settings (font size, font family, line height) to CSS
 * values. The mapping is kept; the font stacks are Eukolia's.
 *
 * One extension over the original: a font value may be a *named* family from
 * the table below, or a CSS font stack of its own. Eukolia's Code Mode reads
 * `editor.fontFamily` as a stack, and Visual Mode has to honour the same
 * setting, so a value the table does not know is used verbatim rather than
 * silently falling back to `monaco`.
 */

export type FontFamily = string

export type LineHeight = 'compact' | 'normal' | 'wide'

/**
 * Eukolia divergence from the reference: the fallbacks after the first family.
 *
 * Overleaf's own stacks end in `Monaco, monospace`, which is right for a
 * platform that ships Monaco and wrong for Windows, where none of JetBrains
 * Mono, Fira Code or Monaco is installed by default — the stack then fell all
 * the way to the generic `monospace`, i.e. Courier New. Eukolia's
 * `--eu-mono-font` names the faces Windows actually has (Cascadia Code, then
 * Consolas) before the generic, and Code Mode's source text is the surface that
 * shows it. The first family of each stack is unchanged, so a machine that has
 * the preferred face still gets Overleaf's metrics.
 */
const WINDOWS_MONO_FALLBACK = `'Cascadia Code', 'Consolas', 'Courier New', monospace`

const fontFamilies: Record<string, string> = {
  monaco: `'Monaco', 'Menlo', 'Ubuntu Mono', ${WINDOWS_MONO_FALLBACK}`,
  consolas: `'Consolas', 'Monaco', 'Menlo', monospace`,
  courier: `'Courier New', 'Courier', monospace`,
  fira: `'Fira Code', 'Fira Mono', 'Monaco', ${WINDOWS_MONO_FALLBACK}`,
  'jetbrains-mono': `'JetBrains Mono', 'Fira Code', ${WINDOWS_MONO_FALLBACK}`,
  'source-code-pro': `'Source Code Pro', 'Consolas', ${WINDOWS_MONO_FALLBACK}`,
  literata: `'Literata', 'Georgia', serif`,
  'noto-serif': `'Noto Serif', 'Georgia', serif`,
  'system-ui': `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`,
}

const lineHeights: Record<LineHeight, string> = {
  compact: '1.3',
  normal: '1.5',
  wide: '1.7',
}

export interface UserStyleOptions {
  fontSize?: number
  fontFamily?: FontFamily
  lineHeight?: LineHeight
}

/** CSS custom-property values consumed by `extensions/theme.ts`. */
export const userStyles = ({
  fontSize = 12,
  fontFamily = 'monaco',
  lineHeight = 'normal',
}: UserStyleOptions) => ({
  fontSize: `${fontSize}px`,
  // A known name resolves through the table; anything else is already a stack.
  fontFamily: fontFamilies[fontFamily] ?? fontFamily,
  lineHeight: lineHeights[lineHeight] ?? lineHeights.normal,
})
