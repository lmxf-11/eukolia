/**
 * Eukolia local mathematics typesetting for the Visual Editor.
 *
 * The visual math widgets obtain their renderer by calling `loadMathJax()`,
 * which loads the mathematics typesetting bundle.
 *
 * There is a unified typesetter in Eukolia — `mathJaxService` in
 * `src/renderer/math/mathjaxService.ts` — and this module is the adapter that
 * presents it through the widget-facing interface:
 *
 *   `loadMathJax()`            -> the loaded MathJax instance (via mathJaxService)
 *   `MathJax.texReset([0])`
 *   `MathJax.tex2svgPromise(tex, { display, em, ex, containerWidth })`
 *   `MathJax.getMetricsFor(el, display)`
 *   `MathJax.typesetPromise([el])` / `MathJax.typesetClear([el])`
 *   `MathJax.svgStylesheet()`
 *
 * When there is no DOM (vitest runs in the `node` environment, and any headless
 * consumer needs the same behaviour), the adapter falls back to driving MathJax
 * 4.1.3 through its Node entry point and LiteDOM adaptor. The TeX configuration
 * is identical in both cases, so an assertion made against the headless output
 * is an assertion about the same typesetting the editor performs.
 */

import { mathJaxService } from '../math/mathjaxService'

/** MathJax metrics, as returned by `MathJax.getMetricsFor`. */
export interface MathJaxMetrics {
  em: number
  ex: number
  containerWidth: number
}

/**
 * A rendered maths result. In the renderer this is an `<mjx-container>`
 * element; headless it is a LiteDOM node that serialises to the same markup.
 */
export type MathJaxOutput = Element & { toString(): string }

/** The subset of the MathJax instance that the ported widgets use. */
export interface MathJaxLike {
  version?: string
  texReset(labels?: number[]): void
  tex2svgPromise(
    tex: string,
    options?: Record<string, unknown>
  ): Promise<MathJaxOutput>
  typesetPromise(elements?: Element[]): Promise<void>
  typesetClear(elements?: Element[]): void
  getMetricsFor(element: Element | null, display?: boolean): MathJaxMetrics
  svgStylesheet(): Element
  startup?: { promise?: Promise<unknown>; adaptor?: unknown }
}

export interface MathJaxTypesetterOptions {
  /** Allow `$...$` as inline maths in addition to `\(...\)`. Overleaf's default. */
  singleDollar?: boolean
  /** `'none-removed'` matches Overleaf: labels are not turned into numbers. */
  numbering?: 'none-removed' | 'none' | 'ams'
}

const hasDom = () =>
  typeof window !== 'undefined' && typeof document !== 'undefined'

/* ------------------------------------------------------------------ *
 * Renderer path — the project's single MathJax service.
 * ------------------------------------------------------------------ */

let rendererAdapter: Promise<MathJaxLike> | undefined

/**
 * Wrap the MathJax instance owned by `mathJaxService` in the widget-facing
 * surface, filling in any method that the service's typed API does not expose.
 */
const createRendererAdapter = async (): Promise<MathJaxLike> => {
  const MathJax = (await mathJaxService.ensureLoaded()) as unknown as Record<
    string,
    any
  >

  return {
    version: MathJax.version,
    texReset: (labels: number[] = []) => MathJax.texReset(labels),
    tex2svgPromise: async (tex, options = {}) =>
      (await MathJax.tex2svgPromise(tex, options)) as MathJaxOutput,
    typesetPromise: async (elements?: Element[]) => {
      if (MathJax.typesetPromise) {
        await MathJax.typesetPromise(elements)
      } else if (elements && elements.length) {
        // `typesetPromise` lives on the startup document in some MathJax
        // builds; fall back to it rather than silently doing nothing.
        await MathJax.startup?.document?.typesetPromise?.(elements)
      }
    },
    typesetClear: (elements?: Element[]) => {
      MathJax.typesetClear?.(elements)
    },
    getMetricsFor: (element: Element | null, display = false) =>
      (MathJax.getMetricsFor?.(element ?? undefined, display) ?? {
        em: 16,
        ex: 8,
        containerWidth: 80 * 16,
      }) as MathJaxMetrics,
    svgStylesheet: () => MathJax.svgStylesheet() as Element,
    startup: MathJax.startup,
  }
}

/* ------------------------------------------------------------------ *
 * Headless path — MathJax 4 via its Node entry point (no DOM).
 * ------------------------------------------------------------------ */

type HeadlessState = { MathJax: any; adaptor: any; document: any }

/**
 * The vendored MathJax distribution, as a directory — for the **headless** path.
 *
 * The extensions live beside `tex-svg.js` in `public/mathjax`, and the loader
 * resolves `[tex]/tikzcd` against this path. It is the same directory the renderer
 * points at, so a test typesets with the same configuration the editor uses. It
 * has to be a plain path, not a `file:` URL: the loader joins it with the rest of
 * the module path before handing the result to `import`.
 *
 * **This is a function, and that is load-bearing rather than stylistic.** It reads
 * `process.cwd()`, which does not exist in a browser: Eukolia's window is created
 * with `nodeIntegration: false`, so `process` is genuinely absent from the
 * renderer's global scope. As a module-level constant this line was evaluated when
 * the *module* was evaluated — and `load-mathjax.ts` imports this file, and the
 * math widgets import that — so the whole renderer threw
 * `ReferenceError: process is not defined` during module evaluation and the
 * application never mounted at all. It presented as an empty window with one line
 * of console output, and nothing about the mathematics it belongs to.
 *
 * Called from inside `loadHeadlessMathJax`, which only the headless path reaches,
 * it is read only where it is meaningful. Where there is no Node the headless path
 * cannot work at all, so the failure is stated rather than guessed around.
 */
const mathJaxRoot = (): string => {
  if (typeof process === 'undefined' || typeof process.cwd !== 'function') {
    throw new Error(
      'the headless MathJax typesetter needs Node; the running editor has a DOM ' +
        'and must use the renderer path (see `hasDom`)'
    )
  }
  return `${process.cwd().replace(/\\/g, '/')}/public/mathjax`
}

let headlessState: Promise<HeadlessState> | undefined
let headlessAdapter: Promise<MathJaxLike> | undefined

const loadHeadlessMathJax = async (): Promise<HeadlessState> => {
  if (!headlessState) {
    headlessState = (async () => {
      // MathJax 4's Node entry resolves its components to absolute paths and
      // hands them to the platform module loader. On Windows that produces a
      // bare `D:\...` specifier, which Node's ESM loader rejects, so route
      // absolute paths through `pathToFileURL` and leave bare package
      // specifiers (`@mathjax/mathjax-newcm-font/...`) untouched.
      const { init } = (await import(/* @vite-ignore */ 'mathjax')) as any
      const { pathToFileURL } = await import('node:url')
      const mjRequire = (file: string) =>
        /^[a-zA-Z]:[\\/]|^\//.test(file)
          ? import(/* @vite-ignore */ pathToFileURL(file).href)
          : import(/* @vite-ignore */ file)

      // `[tex]/tikzcd` is Eukolia's port of the third-party `tikzcd` package: the
      // environment that draws commutative diagrams. It is loaded by name, like
      // every other extension in the vendored distribution, and the loader
      // resolves it to the file beside them. The renderer does the same in
      // `mathjaxService.ts`; both have to, or the feature works in the editor and
      // fails in every test.
      const MathJax = await init({
        loader: {
          load: ['input/tex', 'output/svg', '[tex]/tikzcd'],
          dependencies: { '[tex]/tikzcd': ['input/tex'] },
          require: mjRequire,
          // Where the vendored distribution lives. Without this the loader looks
          // inside the `mathjax` package, which carries no extensions of its own.
          paths: { mathjax: mathJaxRoot() },
        },
        tex: {
          packages: { '[+]': ['tikzcd'] },
          macros: { bm: ['\\boldsymbol{#1}', 1] },
          inlineMath: [
            ['\\(', '\\)'],
            ['$', '$'],
          ],
          displayMath: [
            ['\\[', '\\]'],
            ['$$', '$$'],
          ],
          processEscapes: true,
          processEnvironments: true,
          useLabelIds: false,
          tags: 'none',
        },
      })
      await MathJax.startup?.promise
      return {
        MathJax,
        adaptor: MathJax.startup.adaptor,
        document: MathJax.startup.document,
      }
    })()
  }
  return headlessState
}

const createHeadlessAdapter = async (): Promise<MathJaxLike> => {
  const { MathJax, adaptor, document: mjDocument } = await loadHeadlessMathJax()

  return {
    version: MathJax.version,
    texReset: (labels: number[] = []) => MathJax.texReset(labels),
    tex2svgPromise: async (tex, options = {}) => {
      const node = await MathJax.tex2svgPromise(tex, options)
      const markup = adaptor.outerHTML(node)
      // LiteDOM nodes have no serializer of their own, so the headless path
      // attaches one. Renderer elements already serialise through the DOM.
      Object.defineProperty(node, 'toString', {
        value: () => markup,
        enumerable: false,
        configurable: true,
      })
      return node as MathJaxOutput
    },
    typesetPromise: async (elements?: Element[]) => {
      if (elements && elements.length) {
        await MathJax.typesetPromise(elements)
      }
    },
    typesetClear: (elements?: Element[]) => {
      if (elements && elements.length) {
        MathJax.typesetClear(elements)
      }
    },
    getMetricsFor: () => ({ em: 16, ex: 8, containerWidth: 80 * 16 }),
    svgStylesheet: () =>
      adaptor.text(
        adaptor.textContent(mjDocument.outputJax.styleSheet(mjDocument))
      ) as unknown as Element,
    startup: MathJax.startup,
  }
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Resolve the local MathJax instance used by the Visual Editor.
 *
 * The returned object has the same shape as `window.MathJax` under Overleaf,
 * so the ported widget code is unchanged.
 */
export const createMathJaxTypesetter = (
  _options: MathJaxTypesetterOptions = {}
): Promise<MathJaxLike> => {
  if (hasDom()) {
    rendererAdapter ??= createRendererAdapter()
    return rendererAdapter
  }
  headlessAdapter ??= createHeadlessAdapter()
  return headlessAdapter
}

/**
 * Render TeX to serialised `<mjx-container>` markup.
 *
 * Used by the Visual Editor's tests and by any consumer that wants the markup
 * rather than a live DOM node.
 */
export const typesetToMarkup = async (
  tex: string,
  display = false
): Promise<string> => {
  const MathJax = await createMathJaxTypesetter()
  MathJax.texReset([0])
  const output = await MathJax.tex2svgPromise(tex, { display })
  return String(output)
}

/** Test seam: forget the memoised instances. */
export const resetMathJaxTypesetter = (): void => {
  rendererAdapter = undefined
  headlessAdapter = undefined
  headlessState = undefined
}
