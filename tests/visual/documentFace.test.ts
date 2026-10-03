/**
 * The document face: the one the visual editor sets prose and mathematics in.
 *
 * The report behind these assertions was "support various languages for the
 * rendered text in the visual mode style, as currently it is not working well
 * for Vietnamese", and it survived two earlier attempts because both were
 * argued from the browser instead of from the fonts.
 *
 * What the browser says is worthless here. `getComputedStyle().fontFamily`
 * answers with the stack's first *declared* family — including when that family
 * is not installed at all, which is how `Latin Modern Roman` was reported while
 * every glyph on screen came from Cambria. `document.fonts.check()` returns true
 * for families the machine does not have. And Chromium substitutes a face per
 * character without reporting it, so a font stack that is missing ten Vietnamese
 * codepoints produces one word in two typefaces and no diagnostic anywhere.
 *
 * So these read the character maps out of the font files themselves. A cmap is
 * the font's own statement of what it can draw, and it is the only statement
 * that does not lie.
 *
 * Only `fs` is used, deliberately: `fontTools` is a Python tool and cannot run
 * here, and pulling a font parser into the test suite to answer "is this
 * codepoint in this table" would be a poor trade. The parsers below read exactly
 * the three tables the question needs.
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..', '..')
const RENDERER = path.join(ROOT, 'src', 'renderer')

/** The document face's own stylesheet, which ships the fonts. */
const LATIN_MODERN_CSS = fs.readFileSync(
  path.join(RENDERER, 'latin-modern.css'),
  'utf8'
)
const INDEX_CSS = fs.readFileSync(path.join(RENDERER, 'index.css'), 'utf8')

/**
 * The prose the report was written about, plus one character from every
 * Vietnamese class: the circumflex, the horn, the breve, the D-stroke, and the
 * five tone marks in their precomposed forms.
 */
const VIETNAMESE_SAMPLE =
  'Tôpô compact-mở Đặng Thị Hồng nghiêng ươ ứ ợ ẫ ệ ăđâêôàé'

/**
 * Every Vietnamese precomposed character lives here, so a face that covers only
 * the sample but not the block would still fail.
 */
const LATIN_EXTENDED_ADDITIONAL = Array.from({ length: 90 }, (_, i) => 0x1ea0 + i)

/**
 * The combining marks a decomposed sequence needs. Chromium will not draw half a
 * cluster: if the base letter is present and the mark is not, the whole
 * character comes from the fallback face.
 */
const COMBINING_MARKS = [0x0300, 0x0301, 0x0303, 0x0309, 0x0323]

/** What MathJax draws mathematics with, which the prose has to match. */
const MATHJAX_FONTS = path.join(ROOT, 'public', 'mathjax', 'fonts')

// ---------------------------------------------------------------------------
// A minimal OpenType reader: enough for `head`, `maxp`, `hhea`, `hmtx` and the
// character map, which is all the coverage question needs.
// ---------------------------------------------------------------------------

interface Layout {
  buffer: Buffer
  tables: Map<string, { offset: number; length: number }>
}

function openFont(file: string): Layout {
  const buffer = fs.readFileSync(file)
  const isCollection = buffer.toString('latin1', 0, 4) === 'ttcf'
  // A `.ttc` holds several faces; its own header lists their table directories.
  const directoryOffset = isCollection ? buffer.readUInt32BE(12) : 0
  const tableCount = buffer.readUInt16BE(directoryOffset + 4)

  const tables = new Map<string, { offset: number; length: number }>()
  for (let index = 0; index < tableCount; index += 1) {
    const entry = directoryOffset + 12 + index * 16
    const tag = buffer.toString('latin1', entry, entry + 4)
    tables.set(tag, {
      offset: buffer.readUInt32BE(entry + 8),
      length: buffer.readUInt32BE(entry + 12),
    })
  }
  return { buffer, tables }
}

/** The codepoints a font's character map actually covers. */
function coverage(file: string): Set<number> {
  const font = openFont(file)
  const cmap = font.tables.get('cmap')
  if (!cmap) throw new Error(`${file}: no cmap table`)

  const { buffer } = font
  const subtableCount = buffer.readUInt16BE(cmap.offset + 2)
  const covered = new Set<number>()

  for (let index = 0; index < subtableCount; index += 1) {
    const record = cmap.offset + 4 + index * 8
    const platform = buffer.readUInt16BE(record)
    const encoding = buffer.readUInt16BE(record + 2)
    const offset = cmap.offset + buffer.readUInt32BE(record + 4)
    const format = buffer.readUInt16BE(offset)

    // Windows BMP (3, 1) is the table Chromium reads; (0, 3) and (0, 4) carry
    // the same repertoire when they are present, and format 12 adds the rest.
    const wanted =
      (platform === 3 && (encoding === 1 || encoding === 10)) ||
      (platform === 0 && (encoding === 3 || encoding === 4))
    if (!wanted) continue

    if (format === 4) {
      const segments = buffer.readUInt16BE(offset + 6) / 2
      const ends = offset + 14
      const starts = ends + segments * 2 + 2
      const deltas = starts + segments * 2
      const ranges = deltas + segments * 2
      for (let segment = 0; segment < segments; segment += 1) {
        const end = buffer.readUInt16BE(ends + segment * 2)
        const start = buffer.readUInt16BE(starts + segment * 2)
        if (start === 0xffff) continue
        const delta = buffer.readInt16BE(deltas + segment * 2)
        const rangeOffset = buffer.readUInt16BE(ranges + segment * 2)
        for (let code = start; code <= end; code += 1) {
          if (rangeOffset === 0) {
            if ((code + delta) % 0x10000 !== 0) covered.add(code)
          } else {
            const at = ranges + segment * 2 + rangeOffset + (code - start) * 2
            if (at + 2 <= buffer.length && buffer.readUInt16BE(at) !== 0) covered.add(code)
          }
        }
      }
    } else if (format === 6) {
      const first = buffer.readUInt16BE(offset + 6)
      const count = buffer.readUInt16BE(offset + 8)
      for (let i = 0; i < count; i += 1) {
        if (buffer.readUInt16BE(offset + 10 + i * 2) !== 0) covered.add(first + i)
      }
    } else if (format === 12) {
      const groups = buffer.readUInt32BE(offset + 12)
      for (let group = 0; group < groups; group += 1) {
        const at = offset + 16 + group * 12
        const start = buffer.readUInt32BE(at)
        const end = buffer.readUInt32BE(at + 4)
        for (let code = start; code <= Math.min(end, 0x10ffff); code += 1) covered.add(code)
      }
    }
  }
  return covered
}

const missingFrom = (covered: Set<number>, text: string): string[] =>
  [...new Set([...text])]
    .filter(character => character !== ' ' && !covered.has(character.codePointAt(0)!))
    .sort()

const missingCodes = (covered: Set<number>, codes: number[]): number[] =>
  codes.filter(code => !covered.has(code))

// ---------------------------------------------------------------------------

describe('the document face is vendored, so it is the face that is actually used', () => {
  it('declares Latin Modern Roman in four styles', () => {
    // The stack names the family and MathJax quietly drew mathematics in it; a
    // family the platform does not have resolves to the next entry, silently.
    // Shipping the face is what makes the stack's first entry real.
    const declared = [...LATIN_MODERN_CSS.matchAll(/font-family:\s*'([^']+)'/g)].map(
      match => match[1]
    )
    expect(new Set(declared)).toEqual(new Set(['Latin Modern Roman']))

    const sources = [...LATIN_MODERN_CSS.matchAll(/url\('([^']+)'\)/g)].map(
      match => match[1]
    )
    expect(sources).toHaveLength(4)
    for (const source of sources) {
      // Served from `public/`, so the path is absolute and the file must exist.
      const file = path.join(ROOT, 'public', source.replace(/^\//, ''))
      expect(fs.existsSync(file), `${source} is missing`).toBe(true)
      expect(fs.statSync(file).size).toBeGreaterThan(1000)
    }

    // Each style is declared, or a bold or italic document is drawn in a
    // synthesised slant that is not Latin Modern at all.
    const styles = [...LATIN_MODERN_CSS.matchAll(/font-style:\s*(\w+)/g)].map(
      match => match[1]
    )
    const weights = [...LATIN_MODERN_CSS.matchAll(/font-weight:\s*(\d+)/g)].map(
      match => match[1]
    )
    expect(styles.filter(style => style === 'normal')).toHaveLength(2)
    expect(styles.filter(style => style === 'italic')).toHaveLength(2)
    expect(weights.filter(weight => weight === '400')).toHaveLength(2)
    expect(weights.filter(weight => weight === '700')).toHaveLength(2)

    // `font-display: block`, as for the icon font: a swap period would paint the
    // prose in the fallback face and then reflow it, which is the defect.
    expect([...LATIN_MODERN_CSS.matchAll(/font-display:\s*block/g)]).toHaveLength(4)
  })

  it('is the stack\'s first choice, with a fallback that can still paint Vietnamese', () => {
    const stack = /--eu-serif-font:([^;]+);/.exec(INDEX_CSS)
    expect(stack, '--eu-serif-font is not declared').not.toBeNull()
    const families = stack![1]
      .split(',')
      .map(part => part.trim().replace(/^['"]|['"]$/g, ''))

    expect(families[0]).toBe('Latin Modern Roman')
    expect(families.at(-1)).toBe('serif')
    // Georgia was in this stack and is the earlier half of the same defect: 619
    // characters, missing ten that Vietnamese needs. Book Antiqua has the same
    // gaps, so neither may come back.
    expect(families).not.toContain('Georgia')
    expect(families).not.toContain('Book Antiqua')
  })

  it('loads the stylesheet from the renderer entry point', () => {
    const main = fs.readFileSync(path.join(RENDERER, 'main.tsx'), 'utf8')
    // Before `index.css` for a reason: the document face has to be known when
    // the shell's first paint resolves the stack.
    expect(main).toContain("import './latin-modern.css'")
  })
})

describe('the vendored face paints Vietnamese without help', () => {
  const regular = path.join(ROOT, 'public', 'latin-modern', 'lmroman10-regular.otf')
  const covered = coverage(regular)

  it('covers the reported prose', () => {
    expect(missingFrom(covered, VIETNAMESE_SAMPLE)).toEqual([])
  })

  it('covers every Vietnamese precomposed character', () => {
    // All ninety of Latin Extended Additional U+1EA0–U+1EF9. A face that covers
    // the sample but not the block would pass the test above and still break on
    // the next word an author types.
    expect(missingCodes(covered, LATIN_EXTENDED_ADDITIONAL)).toEqual([])
  })

  it('covers the horned vowels, the D-stroke and the combining marks', () => {
    // The horn is what Cambria's neighbours and Georgia lacked, so it is called
    // out by name rather than left to the block check.
    expect(missingCodes(covered, [0x01a1, 0x01a0, 0x01b0, 0x01af, 0x0110, 0x0111])).toEqual(
      []
    )
    // A base letter present and its mark absent is still a mixed-typeface word:
    // Chromium will not draw half a cluster.
    expect(missingCodes(covered, COMBINING_MARKS)).toEqual([])
  })

  it('has a broad enough repertoire to be the document face at all', () => {
    // A subset that happened to include the sample would pass everything above.
    expect(covered.size).toBeGreaterThan(700)
    for (const code of [0x20ac, 0x2018, 0x2019, 0x201c, 0x201d, 0x2013, 0x2014, 0x2026]) {
      expect(covered.has(code), `U+${code.toString(16)} is missing`).toBe(true)
    }
  })
})

describe('the fallback faces can paint Vietnamese too', () => {
  // `--eu-serif-font` is `'Latin Modern Roman', 'Computer Modern', Cambria,
  // 'Times New Roman', Palatino, serif`. Every one of them that is installed has
  // to cover the whole language, because the browser moves to the next entry for
  // the *whole stack*, not for the character it could not draw.
  const WINDOWS_FONTS = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
  const CANDIDATES: Array<[string, string]> = [
    ['Cambria', 'cambria.ttc'],
    ['Times New Roman', 'times.ttf'],
    ['Palatino', 'pala.ttf'],
  ]

  it.each(CANDIDATES)('%s covers it, or is not installed', (_family, file) => {
    const full = path.join(WINDOWS_FONTS, file)
    if (!fs.existsSync(full)) return // a face that is absent costs nothing
    const covered = coverage(full)
    expect(missingFrom(covered, VIETNAMESE_SAMPLE)).toEqual([])
    expect(missingCodes(covered, LATIN_EXTENDED_ADDITIONAL)).toEqual([])
  })

  it('would reject Georgia, which is why it is not in the stack', () => {
    // The regression this guards against is somebody reading the report as a
    // Vietnamese-only complaint and putting a familiar text face back.
    const georgia = path.join(WINDOWS_FONTS, 'georgia.ttf')
    if (!fs.existsSync(georgia)) return
    const covered = coverage(georgia)
    const missing = missingCodes(covered, LATIN_EXTENDED_ADDITIONAL)
    // Georgia is missing ten of the codepoints the report's own text uses.
    expect(missing.length).toBeGreaterThan(0)
    expect(missingFrom(covered, 'Tôpô compact-mở').length + missing.length).toBeGreaterThan(0)
  })
})

describe('the mathematics and the prose are set in the same face', () => {
  it('ships the Computer Modern face MathJax draws with', () => {
    // The reason a mismatched document face was so visible: mathematics was
    // already Computer Modern, so prose in anything else is two typefaces in one
    // paragraph. MathJax's face comes from this vendored bundle, and it is the
    // same family the stack names — which is why shipping the prose face is the
    // fix rather than a preference.
    expect(fs.existsSync(MATHJAX_FONTS), `${MATHJAX_FONTS} is missing`).toBe(true)
    const bundles = fs
      .readdirSync(MATHJAX_FONTS)
      .filter(name => name.startsWith('mathjax-'))
    expect(bundles.length).toBeGreaterThan(0)
    // NewCM is the Computer Modern MathJax ships.
    expect(bundles.some(name => name.includes('newcm'))).toBe(true)

    // And the service points the typesetter at it, so the vendored copy is the
    // one used rather than a path that happens to resolve.
    const service = fs.readFileSync(
      path.join(RENDERER, 'math', 'mathjaxService.ts'),
      'utf8'
    )
    expect(service).toContain("new URL('./mathjax/fonts', document.baseURI)")
  })
})
