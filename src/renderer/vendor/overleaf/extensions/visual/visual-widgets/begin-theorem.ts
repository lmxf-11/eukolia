import { BeginWidget } from './begin'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { SyntaxNode } from '@lezer/common'
import { typesetNodeIntoElement } from '../utils/typeset-content'
import { loadMathJax } from '@/vendor/overleaf/eukolia/load-mathjax'
import { cachedMathSvg, rememberMathSvg } from './math-render-cache'
import { refreshAfterAsyncWidgetRender } from '../async-widget-render'
import { widgetCoordsAt } from './coords'

export class BeginTheoremWidget extends BeginWidget {
  constructor(
    public environment: string,
    public name: string,
    public argumentNode?: SyntaxNode | null,
    public number?: string,
    public from?: number,
    public to?: number
  ) {
    super(environment, from)
  }

  toDOM(view: EditorView) {
    this.destroyed = false
    const element = document.createElement('span')
    element.classList.add(
      'ol-cm-math',
      'ol-cm-begin',
      'ol-cm-begin-theorem',
      `ol-cm-begin-${this.environment}`
    )
    if (this.from !== undefined) {
      element.dataset.from = String(this.from)
    }
    this.buildElement(element as unknown as HTMLDivElement, view)

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

  updateDOM(element: HTMLElement, view: EditorView) {
    this.destroyed = false
    element.textContent = ''
    element.className = ''
    element.classList.add(
      'ol-cm-math',
      'ol-cm-begin',
      'ol-cm-begin-theorem',
      `ol-cm-begin-${this.environment}`
    )
    if (this.from !== undefined) {
      element.dataset.from = String(this.from)
    }
    this.buildElement(element, view)
    return true
  }

  eq(widget: BeginWidget): boolean {
    return (
      widget instanceof BeginTheoremWidget &&
      widget.environment === this.environment &&
      widget.name === this.name &&
      widget.argumentNode === this.argumentNode &&
      widget.number === this.number &&
      widget.from === this.from
    )
  }


  buildElement(element: HTMLElement, view: EditorView) {
    element.classList.add(
      'ol-cm-math',
      'ol-cm-begin',
      'ol-cm-begin-theorem',
      `ol-cm-begin-${this.environment}`
    )

    const startPadding = document.createElement('span')
    startPadding.classList.add(
      'ol-cm-environment-padding',
      'ol-cm-environment-start-padding'
    )
    element.appendChild(startPadding)

    const headerBox = document.createElement('span')
    headerBox.className = 'eu-theorem-header-box'
    headerBox.setAttribute('role', 'button')
    headerBox.setAttribute(
      'title',
      `Click to edit \\begin{${this.environment}}`
    )

    const isProof = this.environment.toLowerCase() === 'proof'
    const numPart = this.number ? ` ${this.number}` : ''

    const fallbackSpan = document.createElement('span')
    fallbackSpan.className = 'eu-theorem-header-fallback'

    const nameSpan = document.createElement('span')
    nameSpan.className = 'ol-cm-environment-name'
    nameSpan.textContent = this.name
    fallbackSpan.appendChild(nameSpan)

    if (numPart) {
      const numberSpan = document.createElement('span')
      numberSpan.className = 'ol-cm-environment-number'
      numberSpan.textContent = numPart
      fallbackSpan.appendChild(numberSpan)
    }

    let argumentText = ''
    if (this.argumentNode) {
      const suffixElement = document.createElement('span')
      suffixElement.className = 'ol-cm-environment-arg'
      typesetNodeIntoElement(this.argumentNode, suffixElement, view.state)
      fallbackSpan.append(' (', suffixElement, ')')

      argumentText = view.state
        .sliceDoc(this.argumentNode.from, this.argumentNode.to)
        .trim()
      if (argumentText.startsWith('[') && argumentText.endsWith(']')) {
        argumentText = argumentText.slice(1, -1).trim()
      }
    }

    headerBox.appendChild(fallbackSpan)
    element.appendChild(headerBox)

    const endPadding = document.createElement('span')
    endPadding.classList.add(
      'ol-cm-environment-padding',
      'ol-cm-environment-end-padding'
    )
    element.appendChild(endPadding)

    // Typeset into SVG via MathJax
    const tex = isProof
      ? argumentText
        ? `\\textit{Proof (${argumentText}).}`
        : `\\textit{Proof.}`
      : argumentText
        ? `\\textbf{${this.name}${numPart} (${argumentText}).}`
        : `\\textbf{${this.name}${numPart}.}`

    const mountSvg = (svgEl: SVGSVGElement) => {
      svgEl.classList.add('eu-theorem-header-svg')
      fallbackSpan.remove()
      headerBox.prepend(svgEl)
    }

    // Synchronous cached SVG check for instantaneous, zero-delay rendering
    const cached = cachedMathSvg(tex, false, '')
    if (cached) {
      const svgEl = cached.cloneNode(true) as SVGSVGElement
      mountSvg(svgEl)
      return
    }

    loadMathJax()
      .then(async MathJax => {
        if (!this.destroyed && headerBox.isConnected) {
          try {
            const output = await MathJax.tex2svgPromise(tex, {
              display: false,
              em: 16,
              ex: 8,
              containerWidth: 800,
            })
            if (!this.destroyed && headerBox.isConnected) {
              const svgEl = (output.querySelector('svg') || output) as SVGSVGElement
              rememberMathSvg(tex, false, '', svgEl.cloneNode(true) as SVGSVGElement)
              mountSvg(svgEl)
              refreshAfterAsyncWidgetRender(view, element)
            }
          } catch {
            element.classList.add('ol-cm-math-error')
          }
        }
      })
      .catch(() => {
        // Fallback text stays
      })
  }
}
