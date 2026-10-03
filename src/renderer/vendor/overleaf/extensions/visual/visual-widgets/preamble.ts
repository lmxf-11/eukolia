import { EditorSelection, StateEffect } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import { SyntaxNode } from '@lezer/common'
import { materialIcon } from '@/vendor/overleaf/eukolia/material-icon'

function createIcon({
  type,
  accessibilityLabel,
  className,
}: {
  type: string
  accessibilityLabel: string
  className?: string
}) {
  const docFragment = document.createDocumentFragment()

  const buttonIcon = materialIcon(type)
  if (className) {
    buttonIcon.classList.add(className)
  }
  docFragment.append(buttonIcon)

  if (accessibilityLabel) {
    const accessibilityLabelEl = document.createElement('span')
    accessibilityLabelEl.className = 'visually-hidden'
    accessibilityLabelEl.textContent = accessibilityLabel
    docFragment.append(accessibilityLabelEl)
  }

  return docFragment
}

export type Preamble = {
  from: number
  to: number
  title?: {
    node: SyntaxNode
    content: string
  }
  authors: {
    node: SyntaxNode
    content: string
  }[]
}

export const collapsePreambleEffect = StateEffect.define<boolean>()

export class PreambleWidget extends WidgetType {
  constructor(public expanded: boolean) {
    super()
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.classList.add('ol-cm-preamble-wrapper')
    wrapper.classList.toggle('ol-cm-preamble-expanded', this.expanded)
    const element = document.createElement('button')
    wrapper.appendChild(element)
    element.type = 'button'
    element.classList.add('ol-cm-preamble-widget')
    // The state the glyph shows, for assistive technology — the chevron alone
    // is not an announcement.
    element.setAttribute('aria-expanded', this.expanded ? 'true' : 'false')

    /*
     * Eukolia divergence: one target — a chevron, then the label.
     *
     * The reference put `expand_more` on the left whether the preamble was
     * collapsed or expanded (an "expand" arrow on a control whose label says
     * "hide"), gave the row `justify-content: space-between` with the icon as the
     * *second* child so the arrow sat after the text, and put a "Learn more" link
     * to `overleaf.com/learn` beside it. With the port's icon font never loading
     * (see `material-symbols.css`) the glyph was painted as the word "expand",
     * and the row read as debris above the preamble — which is what the report's
     * screenshot shows.
     *
     * The link is gone rather than restyled: it pointed at a web page, in a
     * desktop application that is otherwise entirely local, and it made a
     * disclosure control look like a toolbar. What is left says one thing and
     * does one thing — the chevron shows the state, the label names the action,
     * and the whole row toggles.
     *
     * The control is a real `<button>` with `aria-expanded`, so it is reachable
     * and operable from the keyboard; the widget's `mouseup` listener still
     * handles the caret side of the interaction, and `ignoreEvent` lets key
     * events through so the button's own activation works.
     */
    const label = document.createElement('span')
    label.classList.add('ol-cm-preamble-text')
    label.textContent = this.getToggleText(view)

    const chevron = createIcon({
      type: this.expanded ? 'expand_less' : 'expand_more',
      accessibilityLabel: view.state.phrase(this.expanded ? 'collapse' : 'expand'),
      className: 'ol-cm-preamble-expand-icon',
    })

    const leading = document.createElement('span')
    leading.classList.add('ol-cm-preamble-leading')
    leading.appendChild(chevron)
    leading.appendChild(label)

    element.appendChild(leading)

    element.addEventListener('mouseup', (event: MouseEvent) => {
      if (event.button !== 0) {
        return true
      }
      event.preventDefault()
      if (this.expanded) {
        view.dispatch({
          effects: collapsePreambleEffect.of(true),
        })
      } else {
        view.dispatch({
          selection: EditorSelection.cursor(0),
          scrollIntoView: true,
        })
      }
    })

    return wrapper
  }

  /**
   * Only `mouseup`, so the widget never swallows a keystroke.
   *
   * The toggle is a `<button>`, which the browser activates on Space and Enter by
   * dispatching a click — and a click is not a `mouseup`, so returning `false`
   * for key events would not have helped: the widget has to let them through or
   * the button is mouse-only.
   */
  ignoreEvent(event: Event): boolean {
    return event.type !== 'mouseup' && event.type !== 'click' && event.type !== 'keydown'
  }

  eq(other: PreambleWidget): boolean {
    return this.expanded === other.expanded
  }

  coordsAt(element: HTMLElement) {
    return element.getBoundingClientRect()
  }

  get estimatedHeight() {
    return this.expanded ? -1 : 54
  }

  getToggleText(view: EditorView) {
    if (this.expanded) {
      return view.state.phrase(`hide_document_preamble`)
    }
    return view.state.phrase(`show_document_preamble`)
  }
}
