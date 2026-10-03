import { WidgetType } from '@codemirror/view'

/**
 * A mathematical environment Eukolia cannot render, shown as explained source.
 *
 * `tikz-cd` draws commutative diagrams through TikZ, which is a graphics package
 * rather than a mathematics engine: MathJax cannot render `tikzcd` with or
 * without `\usepackage{tikz-cd}` in the preamble, and `\require{tikz-cd}` is not
 * a MathJax package either. Handing it over produced MathJax's own
 * `Unknown environment 'tikzcd'` error box, which reads as a bug in the editor
 * rather than as a limit of it — and, worse, took the honest answer away: the
 * diagram's source was hidden behind an error.
 *
 * So the source stays, in the source face, with a label saying what it is and why.
 * That is the same shape as §24's raw-LaTeX islands — *render what Eukolia
 * understands; preserve visibly what it does not* — applied to a construct that
 * is mathematics to the author and graphics to every renderer that has to draw
 * it.
 *
 * The caret is never inside it: the decoration is suppressed while the selection
 * intersects the environment (the port's own rule), so the source becomes
 * ordinary editable text the moment the reader puts the cursor in it.
 */
export class UnrenderableMathWidget extends WidgetType {
  constructor(
    /** The environment name, for the label: `tikzcd`. */
    public environment: string,
    /** The environment's own source, shown as-is. */
    public source: string
  ) {
    super()
  }

  toDOM(): HTMLElement {
    const element = document.createElement('div')
    element.classList.add('ol-cm-unrenderable-math')
    element.setAttribute('data-environment', this.environment)

    const label = document.createElement('div')
    label.classList.add('ol-cm-unrenderable-math-label')
    // The label says what this *is* before it says what Eukolia cannot do: a
    // reader should be able to tell a diagram from a failure at a glance.
    label.textContent = `${this.environment} diagram — shown as source`

    const source = document.createElement('pre')
    source.classList.add('ol-cm-unrenderable-math-source')
    source.textContent = this.source

    element.append(label, source)
    return element
  }

  eq(other: UnrenderableMathWidget): boolean {
    return other.environment === this.environment && other.source === this.source
  }

  ignoreEvent(): boolean {
    // Not a control: every event belongs to the editor, so a click puts the
    // caret in the source and the island gives way to it.
    return false
  }

  get estimatedHeight(): number {
    return -1
  }
}
