/**
 * What MathJax's `fontCache` setting actually changes in the markup.
 *
 * The DOM-shape measurement showed the duplication plainly: four equations share 11
 * distinct glyph outlines but write 20 `<path>` elements and 8 923 bytes of glyph
 * data where 4 291 would do. Every copy of a path is a separate thing for the
 * renderer to consider, and the question is whether MathJax can be told to put the
 * glyphs in one place and have each equation *reference* them.
 *
 * `fontCache` is that setting — `local` (the default) keeps a `<defs>` inside each
 * SVG, `global` extracts the definitions into one container in the document. This
 * measures both, through the same vendored distribution the editor uses, so the
 * answer is a fact about this MathJax rather than about its documentation.
 *
 * It is a `node`-environment test because it drives MathJax's Node entry point
 * directly; the editor's copy of the same setting is `mathjaxService.ts`.
 */
import { describe, expect, it } from 'vitest'

interface Output {
  svg: string
  // `global` mode puts the definitions somewhere other than in the returned node.
  found: string[]
}

const CASES = [
  ['inline short', 'a_1^2 + b', false],
  ['fraction', '\\frac{n(n+1)}{2}', false],
  ['greek run', '\\alpha\\beta\\gamma\\delta\\epsilon', false],
] as const

/** Count what is painted: elements, and how much of it is glyph outline data. */
const shape = (markup: string) => {
  const count = (pattern: RegExp) => (markup.match(pattern) ?? []).length
  const paths = [...markup.matchAll(/ d="([^"]*)"/g)].map(match => match[1])
  return {
    bytes: markup.length,
    elements: count(/<[a-zA-Z]/g),
    path: count(/<path/g),
    use: count(/<use/g),
    defs: count(/<defs/g),
    pathData: paths.reduce((sum, data) => sum + data.length, 0),
    distinctPathData: new Set(paths).size,
  }
}

/**
 * Typeset with a given `fontCache`, through MathJax's Node entry point.
 *
 * The adaptor is LiteDOM, so `outerHTML` on the output is the markup the renderer
 * would receive. `global` puts the definitions on the *document* rather than in the
 * node, which is exactly the thing being checked for — so the whole document is
 * serialised and searched, not just the returned node.
 */
const typesetWith = async (
  fontCache: 'local' | 'global',
  tex: string,
  display: boolean
): Promise<Output> => {
  const { init } = (await import('mathjax')) as any
  const { pathToFileURL } = await import('node:url')
  const mjRequire = (file: string) =>
    /^[a-zA-Z]:[\\/]|^\//.test(file)
      ? import(/* @vite-ignore */ pathToFileURL(file).href)
      : import(/* @vite-ignore */ file)

  const MathJax = await init({
    loader: {
      load: ['input/tex', 'output/svg'],
      require: mjRequire,
      paths: { mathjax: `${process.cwd().replace(/\\/g, '/')}/public/mathjax` },
    },
    tex: {
      macros: { cal: '\\mathcal', frak: '\\mathfrak', Bbb: '\\mathbb' },
      packages: { '[-]': ['html', 'require', 'textmacros'] },
    },
    svg: { fontCache },
    startup: { typeset: false },
  })
  await MathJax.startup?.promise

  const node = await MathJax.tex2svgPromise(tex, { display, em: 16, ex: 8 })
  const adaptor = MathJax.startup.adaptor
  const svg = adaptor.outerHTML(node)
  // Anything `global` extracted lives outside the returned node but inside the
  // document the adaptor is driving.
  const documentMarkup = adaptor.outerHTML(MathJax.startup.document.outputJax.adaptor.document.body)
  return { svg, found: [svg, documentMarkup] }
}

describe('the fontCache setting', () => {
  it('prints what each mode puts in the document', async () => {
    const rows: string[] = []
    for (const [label, tex, display] of CASES) {
      for (const fontCache of ['local', 'global'] as const) {
        let output: Output
        try {
          output = await typesetWith(fontCache, tex, display)
        } catch (error) {
          rows.push(`${label} / ${fontCache}: FAILED ${String(error).slice(0, 120)}`)
          continue
        }
        const nodeShape = shape(output.svg)
        const documentShape = shape(output.found[1] ?? '')
        rows.push(
          [
            label.padEnd(14),
            fontCache.padEnd(7),
            `node: bytes ${String(nodeShape.bytes).padStart(5)}`,
            `el ${String(nodeShape.elements).padStart(3)}`,
            `path ${String(nodeShape.path).padStart(2)}`,
            `use ${String(nodeShape.use).padStart(2)}`,
            `defs ${String(nodeShape.defs).padStart(2)}`,
            `pathData ${String(nodeShape.pathData).padStart(5)}`,
            `| document: path ${String(documentShape.path).padStart(2)} pathData ${String(
              documentShape.pathData
            ).padStart(5)}`,
          ].join('  ')
        )
      }
    }
    // eslint-disable-next-line no-console
    console.log('\n' + rows.join('\n'))
    expect(rows.length).toBe(CASES.length * 2)
  })
})
