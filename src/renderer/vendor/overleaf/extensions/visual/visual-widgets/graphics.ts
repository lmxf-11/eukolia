import { EditorView, WidgetType } from '@codemirror/view'
import { placeSelectionInsideBlock } from '../selection'
import { isEqual } from 'lodash'
import { FigureData } from '../../figure-modal'
import { debugConsole } from '@/vendor/overleaf/eukolia/debugging'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import { previewByPathFacet } from '../../file-preview'
import { PdfDestroyLock } from '../utils/pdf-destroy-lock'
import { getEditorScope } from '@/visual/scope'
import { fileUrlToPath } from '@/services/figurePreview'

// Module level to synchronize across all GraphicsWidgets
const pdfDestroyLock = new PdfDestroyLock()

/**
 * A `blob:` URL per SVG figure, made once and kept.
 *
 * CodeMirror destroys the DOM of a block widget that leaves the viewport and
 * builds it again when the figure scrolls back, so this request arrives again on
 * every pass — with a dense drawing, that was a re-read of the whole file, a
 * re-decode and a re-rasterise of every path in it, for pixels identical to the
 * ones that were on screen a moment ago. The blob URL holds the decoded image for
 * as long as it is alive, so a re-mount is an assignment.
 *
 * Bounded, and the URL is revoked when its entry is evicted: a blob URL keeps its
 * bytes alive until it is revoked or the document goes away, and a project of
 * large drawings would otherwise grow for the life of the window.
 */
const MAX_SVG_OBJECT_URLS = 24
const svgObjectUrls = new Map<string, string>()
/**
 * Reads that have started and not finished, so the same figure included twice on
 * screen — a logo in a running header, a diagram referred to from two places — is
 * read once rather than once per widget that asks in the same pass.
 */
const svgReadsInFlight = new Map<string, Promise<string>>()

function rememberSvgObjectUrl(source: string, objectUrl: string): void {
  svgObjectUrls.set(source, objectUrl)
  while (svgObjectUrls.size > MAX_SVG_OBJECT_URLS) {
    const oldest = svgObjectUrls.keys().next().value
    if (oldest === undefined) break
    const evicted = svgObjectUrls.get(oldest)
    svgObjectUrls.delete(oldest)
    if (evicted !== undefined) URL.revokeObjectURL(evicted)
  }
}

/**
 * The bytes of an SVG figure, as a `blob:` URL the `<img>` can render.
 *
 * A project file is reached through the application's own file channel, because a
 * `file:` URL is not fetchable from the renderer (see `createSvgImage`). Anything
 * that is already a URL the renderer may read — a `data:` or `blob:` figure — is
 * still fetched, which keeps this working for a host that resolves figures some
 * other way.
 *
 * A read that fails is not remembered, so the next attempt tries the file again
 * rather than being served a failure for the life of the window.
 */
function svgObjectUrl(url: string): Promise<string> {
  const cached = svgObjectUrls.get(url)
  if (cached !== undefined) {
    // Re-inserted so the eviction above drops the least recently *used*.
    svgObjectUrls.delete(url)
    svgObjectUrls.set(url, cached)
    return Promise.resolve(cached)
  }

  const inFlight = svgReadsInFlight.get(url)
  if (inFlight) return inFlight

  const read = (async () => {
    const path = fileUrlToPath(url)
    const bytes = path
      ? await window.eukoliaApi.readFileBinary(path)
      : new Uint8Array(await (await fetch(url)).arrayBuffer())

    const objectUrl = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: 'image/svg+xml' })
    )
    rememberSvgObjectUrl(url, objectUrl)
    return objectUrl
  })()

  svgReadsInFlight.set(url, read)
  return read.finally(() => {
    svgReadsInFlight.delete(url)
  })
}

/**
 * Forgets every remembered figure and releases its URL.
 *
 * Exported for the same reason `clearRenderCache` is: this is module state, a test
 * file is one module graph, and a figure read in one test would otherwise be
 * served — correctly, but invisibly — to the next. Nothing in the application
 * calls it: the bound above is what keeps a real session in hand.
 */
export function clearSvgFigureCache(): void {
  for (const objectUrl of svgObjectUrls.values()) URL.revokeObjectURL(objectUrl)
  svgObjectUrls.clear()
  svgReadsInFlight.clear()
}

function schedulePdfDestroy(pdf: PDFDocumentProxy) {
  pdfDestroyLock.schedule(() =>
    pdf.destroy().catch(() => {
      debugConsole.warn('Failed to destroy PDFjs instance')
    })
  )
}

export class GraphicsWidget extends WidgetType {
  destroyed = false
  height = 300 // for estimatedHeight, updated when the image is loaded
  pdfInstance: PDFDocumentProxy | null = null

  constructor(
    public filePath: string,
    public centered: boolean,
    public figureData: FigureData | null
  ) {
    super()
  }

  toDOM(view: EditorView): HTMLElement {
    this.destroyed = false

    // this is a block decoration, so it's outside the line decorations from the environment
    const element = document.createElement('div')
    element.classList.add('ol-cm-environment-figure')
    element.classList.add('ol-cm-environment-line')
    element.classList.toggle('ol-cm-environment-centered', this.centered)

    this.renderGraphic(element, view)

    element.addEventListener('mouseup', event => {
      event.preventDefault()
      view.dispatch(placeSelectionInsideBlock(view, event as MouseEvent))
    })

    return element
  }

  eq(widget: GraphicsWidget) {
    return (
      widget.filePath === this.filePath &&
      widget.centered === this.centered &&
      isEqual(this.figureData, widget.figureData)
    )
  }

  updateDOM(element: HTMLImageElement, view: EditorView) {
    this.destroyed = false
    element.classList.toggle('ol-cm-environment-centered', this.centered)
    if (
      this.filePath === element.dataset.filepath &&
      element.dataset.width === String(this.figureData?.width?.toString())
    ) {
      return true
    }
    if (this.pdfInstance) {
      schedulePdfDestroy(this.pdfInstance)
      this.pdfInstance = null
    }
    this.renderGraphic(element, view)
    view.requestMeasure()
    return true
  }

  ignoreEvent(event: Event) {
    return (
      event.type !== 'mouseup' &&
      // Pass events through to the edit button
      !(
        event.target instanceof HTMLElement &&
        event.target.closest('.ol-cm-graphics-edit-button')
      )
    )
  }

  destroy() {
    this.destroyed = true
    if (this.pdfInstance) {
      schedulePdfDestroy(this.pdfInstance)
      this.pdfInstance = null
    }
  }

  coordsAt(element: HTMLElement) {
    return element.getBoundingClientRect()
  }

  get estimatedHeight(): number {
    return this.height
  }

  renderGraphic(element: HTMLElement, view: EditorView) {
    element.textContent = '' // ensure the element is empty

    const preview = view.state.facet(previewByPathFacet)(this.filePath)
    element.dataset.filepath = this.filePath
    element.dataset.width = this.figureData?.width?.toString()

    if (!preview) {
      const message = document.createElement('div')
      message.classList.add('ol-cm-graphics-error')
      message.classList.add('ol-cm-monospace')
      message.textContent = this.filePath
      element.append(message)
      return
    }

    switch (preview.extension) {
      case 'pdf':
      case 'PDF':
        {
          const canvas = document.createElement('canvas')
          canvas.classList.add('ol-cm-graphics')
          this.renderPDF(view, canvas, preview.url).catch(err => {
            if (!this.destroyed) {
              debugConsole.error('Failed to render PDF graphics widget', err)
            }
          })
          element.append(canvas)
        }
        break

      case 'svg':
      case 'SVG':
        element.append(this.createSvgImage(view, preview.url))
        break

      default:
        element.append(this.createImage(view, preview.url))
        break
    }
  }

  getFigureWidth() {
    if (this.figureData?.width) {
      return `min(100%, ${this.figureData.width * 100}%)`
    }
    return ''
  }

  createImage(view: EditorView, url: string) {
    const wrapper = document.createElement('div')
    const image = document.createElement('img')
    image.classList.add('ol-cm-graphics')
    image.classList.add('ol-cm-graphics-loading')
    const width = this.getFigureWidth()
    image.style.width = width
    image.style.maxWidth = width

    image.src = url
    image.addEventListener('load', () => {
      image.classList.remove('ol-cm-graphics-loading')
      this.height = image.height // for estimatedHeight
      view.requestMeasure()
    })
    image.addEventListener('error', () => {
      const errorElement = this.createErrorElement(view)
      wrapper.replaceChildren(errorElement)
      this.height = wrapper.clientHeight
      view.requestMeasure()
    })

    wrapper.appendChild(image)
    return wrapper
  }

  /**
   * Creates an image element for SVG files.
   *
   * An `<img>` will not render an SVG served as `application/octet-stream`, which
   * is what a project file is, so the bytes are read and handed to the browser as
   * a `blob:` URL carrying the right type.
   *
   * How those bytes are read is the part that had to change. This used to
   * `fetch(url)` the `file:` URL the figure index holds, and a `file:` URL cannot
   * be fetched: Chromium's Fetch API rejects the scheme outright, and the
   * renderer's own Content-Security-Policy (`index.html`) admits `'self'`, `data:`
   * and `blob:` for `connect-src` and nothing else. The promise therefore always
   * rejected, every SVG figure fell to the "can't preview this type of image file"
   * element, and the failure repeated on every scroll back into view — the console
   * error it logged each time is mirrored into `eukolia.log` as well. Reading
   * through the same `fs:readFileBinary` channel the PDF figures already use works
   * in both the development origin and the packaged one, and keeps the blob the
   * `<img>` gets identical.
   */
  createSvgImage(view: EditorView, url: string) {
    const wrapper = document.createElement('div')
    const image = document.createElement('img')
    image.classList.add('ol-cm-graphics')
    image.classList.add('ol-cm-graphics-loading')
    const width = this.getFigureWidth()
    image.style.width = width
    image.style.maxWidth = width

    const showError = () => {
      const errorElement = this.createErrorElement(view)
      wrapper.replaceChildren(errorElement)
      this.height = wrapper.clientHeight
      view.requestMeasure()
    }

    svgObjectUrl(url)
      .then(objectUrl => {
        if (this.destroyed) {
          return
        }

        image.addEventListener(
          'load',
          () => {
            image.classList.remove('ol-cm-graphics-loading')
            this.height = image.height
            view.requestMeasure()
          },
          { once: true }
        )

        image.addEventListener('error', showError, { once: true })

        image.src = objectUrl
      })
      .catch(() => {
        if (this.destroyed) {
          return
        }
        showError()
      })

    wrapper.appendChild(image)
    return wrapper
  }

  createErrorElement(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.classList.add('ol-cm-graphics-loading-error')
    const title = document.createElement('span')
    title.classList.add('ol-cm-graphics-loading-error-title')
    title.textContent = view.state.phrase(
      'the_visual_editor_cant_preview_this_type_of_image_file'
    )
    const subtitle = document.createElement('span')
    subtitle.classList.add('ol-cm-graphics-loading-error-subtitle')
    subtitle.textContent = view.state.phrase(
      'click_recompile_and_check_your_pdf_to_see_how_its_looking'
    )
    wrapper.appendChild(title)
    wrapper.appendChild(subtitle)
    return wrapper
  }

  /**
   * Renders page 1 of an embedded PDF figure.
   *
   * Overleaf loads PDF.js in the page and rasterises the page itself. Eukolia's
   * PDF engine lives behind the editor scope, because it belongs to the main
   * process; a scope that does not provide `renderPdfFigurePage` gets the
   * "cannot preview" state instead of a blank canvas.
   */
  async renderPDF(view: EditorView, canvas: HTMLCanvasElement, url: string) {
    if (this.destroyed) {
      return
    }

    await pdfDestroyLock.waitForPending()
    if (this.destroyed) {
      return
    }

    const scope = getEditorScope()
    if (!scope?.renderPdfFigurePage) {
      canvas.replaceWith(this.createErrorElement(view))
      return
    }

    try {
      const width = canvas.clientWidth || 600
      await scope.renderPdfFigurePage({ url, canvas, width })
    } catch (error) {
      debugConsole.error('Failed to render PDF graphics widget', error)
      canvas.replaceWith(this.createErrorElement(view))
      return
    }

    if (this.destroyed) {
      return
    }

    this.height = canvas.height || this.height
    view.requestMeasure()
  }
}
