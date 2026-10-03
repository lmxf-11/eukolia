import { EditorSelection } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import { widgetCoordsAt } from './coords'

export class BeginWidget extends WidgetType {
  destroyed = false

  constructor(
    public environment: string,
    public from?: number
  ) {
    super()
  }

  toDOM(view: EditorView): HTMLElement {
    this.destroyed = false
    const element = document.createElement('span')
    if (this.from !== undefined) {
      element.dataset.from = String(this.from)
    }
    this.buildElement(element, view)

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

  eq(widget: BeginWidget) {
    return widget.environment === this.environment && widget.from === this.from
  }

  updateDOM(element: HTMLElement, view: EditorView) {
    this.destroyed = false
    element.textContent = ''
    element.className = ''
    if (this.from !== undefined) {
      element.dataset.from = String(this.from)
    }
    this.buildElement(element, view)
    return true
  }

  destroy() {
    this.destroyed = true
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown' && event.type !== 'mouseup'
  }

  coordsAt(element: HTMLElement, pos?: number, side?: number) {
    return widgetCoordsAt(element, pos, side)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  buildName(name: HTMLSpanElement, view: EditorView) {
    name.textContent = this.environment
  }

  buildElement(element: HTMLElement, view: EditorView) {
    element.classList.add('ol-cm-begin', `ol-cm-begin-${this.environment}`)

    const startPadding = document.createElement('span')
    startPadding.classList.add(
      'ol-cm-environment-padding',
      'ol-cm-environment-start-padding'
    )
    element.appendChild(startPadding)

    const name = document.createElement('span')
    name.classList.add('ol-cm-environment-name')
    this.buildName(name, view)
    element.appendChild(name)

    const endPadding = document.createElement('span')
    endPadding.classList.add(
      'ol-cm-environment-padding',
      'ol-cm-environment-end-padding'
    )
    element.appendChild(endPadding)
  }
}
