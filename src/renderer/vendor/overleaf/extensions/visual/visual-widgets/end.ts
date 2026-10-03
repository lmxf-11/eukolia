import { EditorSelection } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import { widgetCoordsAt } from './coords'

/**
 * EndWidget renders \end{...} as an SVG end marker rather than a line.
 * For proofs: a filled QED tombstone SVG (■).
 * For theorems/propositions/others: a boxed `end` marker SVG.
 * Enterable by clicking at or moving the caret to it.
 */
export class EndWidget extends WidgetType {
  constructor(
    public environment: string = '',
    public from?: number
  ) {
    super()
  }

  toDOM(view: EditorView) {
    const element = document.createElement('span')
    element.classList.add('ol-cm-math', 'ol-cm-end', 'eu-cm-end-container')
    if (this.from !== undefined) {
      element.dataset.from = String(this.from)
    }
    if (this.environment) {
      element.classList.add(`ol-cm-end-${this.environment}`)
    }

    const isProof = this.environment.toLowerCase() === 'proof'

    const marker = document.createElement('span')
    marker.style.cursor = 'pointer'
    marker.setAttribute('role', 'button')

    if (isProof) {
      marker.className = 'eu-cm-qed-box'
      marker.setAttribute('title', 'End of proof (click to edit \\end{proof})')
      marker.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 12 12" class="eu-cm-qed-svg" aria-label="QED" style="display:inline-block;vertical-align:middle;">
          <rect x="0.5" y="0.5" width="11" height="11" fill="currentColor"/>
        </svg>
      `
    } else {
      marker.className = 'eu-cm-end-box'
      marker.setAttribute(
        'title',
        `End of ${this.environment || 'environment'} (click to edit \\end{${this.environment}})`
      )
      marker.innerHTML = `
        <svg width="34" height="20" viewBox="0 0 34 20" class="eu-cm-end-box-svg" aria-label="End of environment" style="display:inline-block;vertical-align:middle;">
          <rect x="0.5" y="0.5" width="33" height="19" rx="3" fill="var(--eu-editor-bg, transparent)" stroke="var(--eu-border-strong, var(--eu-border, currentColor))" stroke-width="1" style="fill: var(--eu-editor-bg, transparent);"/>
          <text x="17" y="13.5" text-anchor="middle" font-size="10.5" font-family="var(--source-font-family, monospace)" font-weight="600" fill="var(--eu-editor-fg, currentColor)">end</text>
        </svg>
      `
    }

    element.appendChild(marker)

    element.addEventListener('mousedown', event => {
      const e = event as MouseEvent
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()

      let targetPos: number
      if (this.from !== undefined) {
        targetPos = this.from + 1
      } else {
        try {
          targetPos = view.posAtDOM(element)
        } catch {
          return
        }
      }

      view.dispatch({
        selection: EditorSelection.cursor(targetPos),
        scrollIntoView: true,
      })
      view.focus()
    })

    return element
  }

  eq(widget: EndWidget) {
    return widget.environment === this.environment && widget.from === this.from
  }

  updateDOM(element: HTMLElement) {
    if (this.from !== undefined) {
      element.dataset.from = String(this.from)
    }
    return true
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown' && event.type !== 'mouseup'
  }

  coordsAt(element: HTMLElement, pos?: number, side?: number) {
    return widgetCoordsAt(element, pos, side)
  }
}
