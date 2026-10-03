// @vitest-environment jsdom
/**
 * An SVG figure, read through the application's file channel.
 *
 * Two things are pinned here, and the first was a bug rather than a slowness.
 *
 * **A `file:` URL cannot be fetched.** The widget used to `fetch(preview.url)`,
 * and `preview.url` is always a `file:///C:/…` URL (`figureIndex`, from
 * `pathToFileUrl`). Chromium's Fetch API rejects the scheme outright, and the
 * renderer's Content-Security-Policy admits `'self'`, `data:` and `blob:` for
 * `connect-src` and nothing else — so the promise always rejected, every SVG
 * figure showed the "can't preview this type of image file" element, and the
 * console error it logged each time was mirrored into `eukolia.log`. Reading the
 * bytes through `fs:readFileBinary`, the channel PDF figures already use, works in
 * both the development origin and the packaged one.
 *
 * **The same figure is asked for again on every scroll pass.** CodeMirror destroys
 * the DOM of a block widget that leaves the viewport and builds it again on the
 * way back, so a dense drawing was re-read, re-decoded and re-rasterised for
 * pixels identical to the ones that had just been on screen. The `blob:` URL holds
 * the decoded image for as long as it is alive, so the second ask is an
 * assignment.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import {
  clearSvgFigureCache,
  GraphicsWidget,
} from '@/vendor/overleaf/extensions/visual/visual-widgets/graphics'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'

const SVG_URL = 'file:///C:/proj/figures/plot.svg'
const SVG_PATH = 'C:/proj/figures/plot.svg'

let reads: string[] = []
/** How many object URLs have been minted, which is one per file actually read. */
let objectUrls = 0

/*
 * jsdom implements neither object-URL entry point, and both are part of the
 * browser contract this module is written against — so they are installed once
 * for the file rather than restored between tests.
 */
Object.defineProperty(URL, 'createObjectURL', {
  configurable: true,
  writable: true,
  value: () => {
    objectUrls += 1
    return `blob:eukolia-test/${objectUrls}`
  },
})
Object.defineProperty(URL, 'revokeObjectURL', {
  configurable: true,
  writable: true,
  value: () => undefined,
})

const view = (): EditorView =>
  new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [
        filePreview(path =>
          path === 'figures/plot.svg' ? { url: SVG_URL, extension: 'svg' } : null,
        ),
      ],
    }),
  })

const widget = (): GraphicsWidget => new GraphicsWidget('figures/plot.svg', false, null)

/** One turn of the microtask queue, plus whatever the read settles into. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const serveBytes = (): void => {
  ;(window as unknown as { eukoliaApi: unknown }).eukoliaApi = {
    readFileBinary: (path: string) => {
      reads.push(path)
      return Promise.resolve(new Uint8Array([60, 115, 118, 103, 62]))
    },
  }
}

beforeEach(() => {
  // The figure cache is module state and this file is one module graph: without
  // clearing it, a figure read in one test would be served to the next — which is
  // the behaviour under test, so it has to start empty.
  clearSvgFigureCache()
  reads = []
  objectUrls = 0
  serveBytes()
})

describe('an SVG figure is read from the file rather than fetched from a file: URL', () => {
  it('reads the file through the application channel', async () => {
    const element = widget().toDOM(view())
    await settle()
    expect(reads).toEqual([SVG_PATH])
    expect(element.querySelector('img')?.getAttribute('src')).toBe('blob:eukolia-test/1')
    // No error state, which is what every SVG figure used to show.
    expect(element.querySelector('.ol-cm-graphics-loading-error')).toBeNull()
  })

  it('reads the same figure once, however many times it is mounted', async () => {
    const first = widget().toDOM(view())
    await settle()
    const second = widget().toDOM(view())
    await settle()

    expect(reads).toEqual([SVG_PATH])
    expect(objectUrls).toBe(1)
    expect(first.querySelector('img')?.getAttribute('src')).toBe(
      second.querySelector('img')?.getAttribute('src'),
    )
  })

  it('reads a figure mounted twice in one pass only once', async () => {
    const first = widget().toDOM(view())
    const second = widget().toDOM(view())
    await settle()

    expect(reads).toEqual([SVG_PATH])
    expect(objectUrls).toBe(1)
    expect(first.querySelector('img')?.getAttribute('src')).toBe('blob:eukolia-test/1')
    expect(second.querySelector('img')?.getAttribute('src')).toBe('blob:eukolia-test/1')
  })

  it('shows the error state when the file cannot be read', async () => {
    ;(window as unknown as { eukoliaApi: unknown }).eukoliaApi = {
      readFileBinary: () => Promise.reject(new Error('gone')),
    }
    const element = widget().toDOM(view())
    await settle()
    expect(element.querySelector('.ol-cm-graphics-loading-error')).not.toBeNull()
  })

  it('tries the file again after a failure, rather than remembering it', async () => {
    ;(window as unknown as { eukoliaApi: unknown }).eukoliaApi = {
      readFileBinary: () => Promise.reject(new Error('gone')),
    }
    widget().toDOM(view())
    await settle()

    serveBytes()
    const retry = widget().toDOM(view())
    await settle()
    expect(reads).toEqual([SVG_PATH])
    expect(retry.querySelector('img')?.getAttribute('src')).toBe('blob:eukolia-test/1')
  })
})
