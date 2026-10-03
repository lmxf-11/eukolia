import { EditorSelection } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import { widgetCoordsAt } from './coords'

/**
 * Renders \label{} as an SVG label icon (top-left to bottom-right).
 * Clicking at the icon places the caret inside \label{...} for editing.
 */
export class LabelIconWidget extends WidgetType {
  constructor(public from?: number) {
    super()
  }

  toDOM(view: EditorView) {
    const element = document.createElement('span')
    element.classList.add('ol-cm-brace', 'ol-cm-icon-brace', 'eu-cm-label-icon-wrap')
    element.setAttribute('title', 'Label (click to edit)')
    element.setAttribute('role', 'button')
    element.style.cursor = 'pointer'

    element.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="eu-cm-label-icon" style="vertical-align: -0.15em; margin-right: 3px; display: inline-block;">
        <path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/>
        <circle cx="7" cy="7" r="1.5" fill="currentColor"/>
      </svg>
    `

    element.addEventListener('mousedown', event => {
      const e = event as MouseEvent
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()

      const targetPos =
        this.from !== undefined ? this.from + 1 : view.posAtDOM(element)

      view.dispatch({
        selection: EditorSelection.cursor(targetPos),
        scrollIntoView: true,
      })
      view.focus()
    })

    return element
  }

  eq(widget: LabelIconWidget) {
    return widget.from === this.from
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown' && event.type !== 'mouseup'
  }

  coordsAt(element: HTMLElement, pos?: number, side?: number) {
    return widgetCoordsAt(element, pos, side)
  }
}
