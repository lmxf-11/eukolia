/**
 * A parser for the `tikzcd` environment's source syntax.
 *
 * This file is deliberately free of any MathJax dependency, and deliberately
 * plain JavaScript: it is loaded as a runtime ES module by the extension beside
 * it, in the browser *and* under Node, so it cannot carry TypeScript syntax. The
 * types below are JSDoc, which `tsc` checks at every call site that imports it.
 *
 * Keeping the parser out of the MathJax extension is the single most valuable
 * structural decision in the port: it makes the hard part — tikzcd's own syntax —
 * testable in Node without a typesetter, and leaves only the part that has to
 * talk to MathJax's internals untestable and small.
 *
 * Syntax covered (the order is the order of the staged plan):
 *
 *   `&` cells, `\\` rows, nested braces and nested environments not split;
 *   `\arrow[dir]`, `\ar[dir]` and the `\rar`/`\dar`/`\drar` family;
 *   quoted labels `"f"`, `"f"'`, `"f"''` and `{below}{above}` options;
 *   full option lists, including `from=1-1,to=2-2` arrows that sit on no cell.
 *
 * It reads a diagram in two shapes, both of which tests rely on:
 *
 *   `parseTikzcd(body)` → `{cells, arrows, rows, columns, diagramOptions, error}`,
 *   where each cell carries the mathematics that is left once its arrows are
 *   removed and each arrow carries its own direction, endpoints, labels and
 *   options unresolved — no geometry is decided here;
 *
 *   `layoutGrid(metrics)` → `{boxes, width, height, depth}`, which turns the
 *   column widths and row heights MathJax measured into cell boxes in ems, with
 *   the origin at the diagram's left edge on the baseline and `y` growing up.
 */

/* ------------------------------------------------------------------ *
 * Public shapes (JSDoc)
 * ------------------------------------------------------------------ */

/**
 * A grid position, 1-based, row first — `{row: 1, column: 2}` is `1-2`, the same
 * cell reference tikzcd's own `from=`/`to=` options use.
 *
 * @typedef {{row: number, column: number}} GridPos
 */

/**
 * One cell of the grid, with every arrow command removed from its content.
 *
 * @typedef {{row: number, column: number, content: string}} Cell
 */

/**
 * An arrow option: its name, and its value when it has one.
 *
 * @typedef {[string, string | true]} ArrowOption
 */

/**
 * The `\arrow[…]` command, as written. Nothing here has been resolved to
 * geometry — that is the extension's job, and it is what makes this testable.
 *
 * @typedef {object} ArrowSpec
 * @property {GridPos | null} host      The cell the `\arrow` is written in, or null.
 * @property {GridPos | null} from      `from=` as written, or null.
 * @property {GridPos | null} to        `to=` as written, or null.
 * @property {string | null} direction  The direction string, when one was given.
 * @property {{dx: number, dy: number} | null} delta  Steps across and down.
 * @property {string[]} labels          Label sources, without their quotes.
 * @property {string[]} labelPlacements `'`, `''`, `below`, `above`, … per label.
 * @property {ArrowOption[]} options    Every option, in order.
 * @property {string} command           The command as written: `arrow`, `rar`, …
 */

/**
 * What `parseTikzcd` returns.
 *
 * @typedef {object} TikzcdBody
 * @property {Cell[]} cells
 * @property {ArrowSpec[]} arrows
 * @property {number} rows
 * @property {number} columns
 * @property {string} diagramOptions  Leading `[…]` of `\begin{tikzcd}[…]`.
 * @property {{row: Object<number,string>, column: Object<number,string>}} [spacing]
 * @property {string | null} error    Why the body could not be read, if it could not.
 */

/**
 * One cell's box in ems, in a coordinate system whose origin is the diagram's
 * left edge on the baseline: `x` grows right, `y` grows **up**.
 *
 * @typedef {object} CellBox
 * @property {number} row      1-based.
 * @property {number} column   1-based.
 * @property {number} left
 * @property {number} right
 * @property {number} top      Above the baseline.
 * @property {number} bottom   Positive downwards from the baseline.
 * @property {number} width    Width of this column — the widest cell in it.
 * @property {number} height   Height of this row, top plus bottom.
 * @property {number} baseline The row's baseline, above the diagram's baseline.
 */

/**
 * The placed grid.
 *
 * @typedef {object} GridLayout
 * @property {CellBox[]} boxes
 * @property {number} width   Total width, in ems.
 * @property {number} height  Total height above the baseline.
 * @property {number} depth   Total depth below the baseline, positive.
 */

/**
 * What MathJax measured, which is all `layoutGrid` needs to place the grid.
 *
 * @typedef {object} GridMetrics
 * @property {number[]} columnWidths  Widest cell in each column, in ems.
 * @property {number[]} rowHeights    Height above the baseline, per row.
 * @property {number[]} rowDepths     Depth below the baseline, per row.
 * @property {number[]} rowBaselines  Where each row's baseline sits in MathJax's
 *                                    own row stack, in ems above the first row's.
 * @property {number} rows
 * @property {number} columns
 * @property {number} columnSpacing
 * @property {number} rowSpacing
 */

/* ------------------------------------------------------------------ *
 * Helpers — brace-aware scanning
 * ------------------------------------------------------------------ */

/** The letters a direction string is built from, and the step each one takes. */
const STEP_COLUMN = { r: 1, l: -1 }
const STEP_ROW = { d: 1, u: -1 }

/**
 * Every `\arrow`-family command, longest first, so that `\arrow` is preferred
 * over `\ar` and `\rar` over a shorter name it starts with.
 */
const ARROW_COMMANDS = (() => {
  const names = ['arrow', 'ar']
  for (const first of ['r', 'l', 'd', 'u']) {
    names.push(first + 'ar')
    for (const second of ['r', 'l', 'd', 'u']) names.push(first + second + 'ar')
  }
  return names.sort((a, b) => b.length - a.length)
})()

/** @param {string} ch */
const isLetter = (ch) => ch >= 'a' && ch <= 'z'

/**
 * If `tex` has an arrow command at `i`, return it; otherwise null.
 *
 * `\arrow` and `\ar` only count when a `[….]` follows, which is what the syntax
 * requires — that is what keeps `\arrow` in a label such as `"{\arrow}"` from
 * being read as an arrow. The `\rar` family carries its direction in its own name
 * and may be written bare, so `matched` says whether the bracket was there.
 *
 * @param {string} tex
 * @param {number} i
 * @returns {{name: string, end: number, matched: boolean} | null}
 */
function arrowCommandAt(tex, i) {
  if (tex.charAt(i) !== '\\') return null
  const rest = tex.slice(i + 1)
  for (const name of ARROW_COMMANDS) {
    if (!rest.startsWith(name)) continue
    if (isLetter(rest.charAt(name.length))) continue
    const shorthand = directionFromCommand(name) !== null
    let k = i + 1 + name.length
    while (k < tex.length && /\s/.test(tex.charAt(k))) k++
    if (tex.charAt(k) === '[')
      return { name, end: i + 1 + name.length, matched: true }
    if (shorthand) return { name, end: i + 1 + name.length, matched: false }
  }
  return null
}

/**
 * Skips a balanced `{…}`, `[…]` or `"…"` group and returns the index just after
 * it. A quote followed by `'` is a label placement, not a close.
 *
 * @param {string} tex
 * @param {number} i
 * @returns {number}
 */
function skipGroup(tex, i) {
  const open = tex.charAt(i)
  if (open === '{' || open === '[') {
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let k = i
    while (k < tex.length) {
      const ch = tex.charAt(k)
      if (ch === '\\') {
        k += 2
        continue
      }
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) return k + 1
      }
      k++
    }
    return tex.length
  }
  if (open === '"') {
    let k = i + 1
    while (k < tex.length) {
      if (tex.charAt(k) !== '"') {
        k++
        continue
      }
      // A quote is part of the label when another quote follows it — in `"f''"`
      // the closing quote is the last one. Otherwise this is the closing quote,
      // and it is the last one of the run so a following `'` (`"f"'`, `"f"''`,
      // which place the label below the arrow) stays outside the label.
      if (tex.charAt(k + 1) === '"') {
        k++
        continue
      }
      let close = k
      while (tex.charAt(close + 1) === '"' && tex.charAt(close + 2) !== "'")
        close++
      return close + 1
    }
    return tex.length
  }
  return i + 1
}

/**
 * The raw contents of the group starting at `i`, delimiters removed.
 *
 * @param {string} tex
 * @param {number} i
 * @returns {string}
 */
function groupBody(tex, i) {
  return tex.slice(i + 1, skipGroup(tex, i) - 1)
}

/**
 * The text of a quoted label starting at `i` in `tex`, with the quotes removed and
 * any `'` placement that follows them returned separately.
 *
 * @param {string} tex
 * @param {number} i  The index of the opening `"`.
 * @returns {{label: string, placement: string}}
 */
function unquote(tex, i, optionPart = false) {
  const end = skipGroup(tex, i)
  const label = tex.slice(i + 1, end - 1)
  const placement = optionPart
    ? tex
        .slice(end)
        .trim()
        .replace(/^\{([^]*)\}$/, '$1')
    : /^'*/.exec(tex.slice(end))[0]
  return { label, placement }
}

/* ------------------------------------------------------------------ *
 * Options and labels
 * ------------------------------------------------------------------ */

/**
 * Split a value on commas that are not inside braces, brackets or quotes.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitCommas(text) {
  /** @type {string[]} */
  const parts = []
  let start = 0
  let depth = 0
  let quote = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (ch === '\\') {
      i++
      continue
    }
    if (quote) {
      if (ch === '"') quote = false
      continue
    }
    if (ch === '"') quote = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/**
 * Split `key=value` at the first `=` that is not inside braces or quotes.
 *
 * @param {string} part
 * @returns {ArrowOption}
 */
function splitOption(part) {
  for (let i = 0; i < part.length; i++) {
    const ch = part.charAt(i)
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '{' || ch === '"') {
      i = skipGroup(part, i) - 1
      continue
    }
    if (ch === '=') {
      const value = part.slice(i + 1).trim()
      return [part.slice(0, i).trim(), value.replace(/^\{([^]*)\}$/, '$1')]
    }
  }
  return [part.trim(), true]
}

/**
 * The option list of `\arrow[…]`, in order.
 *
 * A quoted label is usually written inside the option brackets — `\ar[r,"f"]` —
 * so the part after the quotes is kept: it is the label's placement, and the
 * caller reads it as one. Without that, the quotes would be lost and the label
 * with them.
 *
 * @param {string} text
 * @returns {ArrowOption[]}
 */
function parseOptions(text) {
  /** @type {ArrowOption[]} */
  const options = []
  for (const part of splitCommas(text)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    if (trimmed.charAt(0) === '"') {
      const end = skipGroup(trimmed, 0)
      const labels = trimmed.slice(0, end)
      const rest = trimmed.slice(end).trim()
      options.push([labels, true])
      if (rest) options.push([rest, true])
      continue
    }
    options.push(splitOption(trimmed))
  }
  return options
}

/**
 * Look an option up case-insensitively.
 *
 * @param {ArrowOption[]} options
 * @param {string} name
 * @returns {string | true | undefined}
 */
function optionValue(options, name) {
  for (const [key, value] of options) {
    if (key.toLowerCase() === name.toLowerCase()) return value
  }
  return undefined
}

/**
 * True when a flag option is present and not switched off (`dashed=false`).
 *
 * @param {ArrowOption[]} options
 * @param {string} name
 * @returns {boolean}
 */
function hasOption(options, name) {
  const value = optionValue(options, name)
  return value !== undefined && value !== 'false'
}

/**
 * An option's numeric value, or `fallback` when it has none.
 *
 * @param {ArrowOption[]} options
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numberOption(options, name, fallback) {
  const value = optionValue(options, name)
  if (value === undefined || value === true) return fallback
  const parsed = Number.parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Words that place a label rather than name it. */
const PLACEMENTS = /^(above|below|left|right)$/

/**
 * Read the label sequence that follows `\arrow[…]`: quoted strings, each with an
 * optional `'`/`''` placement, and `{below}`-style arguments.
 *
 * @param {string} tex
 * @param {number} i
 * @returns {{labels: string[], placements: string[], end: number}}
 */
function parseLabels(tex, i) {
  /** @type {string[]} */
  const labels = []
  /** @type {string[]} */
  const placements = []
  let k = i
  for (;;) {
    while (k < tex.length && /\s/.test(tex.charAt(k))) k++
    const ch = tex.charAt(k)

    if (ch === '"') {
      const quoted = unquote(tex, k)
      labels.push(quoted.label)
      placements.push(quoted.placement)
      k = skipGroup(tex, k) + quoted.placement.length
      // `{below}` / `{above}` may follow the quotes directly.
      for (;;) {
        let j = k
        while (j < tex.length && /\s/.test(tex.charAt(j))) j++
        if (tex.charAt(j) !== '{') break
        const body = groupBody(tex, j).trim()
        if (!PLACEMENTS.test(body)) break
        const placement = placements[placements.length - 1]
        placements[placements.length - 1] = placement
          ? placement + ' ' + body
          : body
        k = skipGroup(tex, j)
      }
      continue
    }

    if (ch === '{') {
      const body = groupBody(tex, k)
      const trimmed = body.trim()
      // `{below}` is a placement for the label just read, not a label of its own.
      if (PLACEMENTS.test(trimmed) && labels.length) {
        const placement = placements[placements.length - 1]
        placements[placements.length - 1] = placement
          ? placement + ' ' + trimmed
          : trimmed
      } else {
        labels.push(body)
        placements.push(PLACEMENTS.test(trimmed) ? trimmed : '')
      }
      k = skipGroup(tex, k)
      continue
    }

    break
  }
  return { labels, placements, end: k }
}

/* ------------------------------------------------------------------ *
 * Directions and cell references
 * ------------------------------------------------------------------ */

/**
 * Count the steps in a direction string such as `r`, `dr`, `rr`, `ddr`.
 *
 * `rrd` is two columns across and one down, which is how tikz-cd's own
 * multi-step arrows are written. Returns null for anything that is not a
 * direction string, or that steps nowhere.
 *
 * @param {string} direction
 * @returns {{dx: number, dy: number} | null}
 */
function directionDelta(direction) {
  let dx = 0
  let dy = 0
  for (const ch of direction) {
    if (ch in STEP_COLUMN) dx += STEP_COLUMN[ch]
    else if (ch in STEP_ROW) dy += STEP_ROW[ch]
    else return null
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) return null
  }
  if (dx === 0 && dy === 0) return null
  return { dx, dy }
}

/**
 * The direction string a `\rar`-family command implies.
 *
 * @param {string} command
 * @returns {string | null}
 */
function directionFromCommand(command) {
  if (!command.endsWith('ar') || command === 'ar' || command === 'arrow')
    return null
  return command.slice(0, -2)
}

/**
 * `1-2` — or `{1}-{2}` — to a grid position.
 *
 * @param {string} text
 * @returns {GridPos | null}
 */
function parseCellRef(text) {
  const match = /^\s*\{?\s*(\d+)\s*\}?\s*-\s*\{?\s*(\d+)\s*\}?\s*$/.exec(text)
  if (!match) return null
  const row = Number.parseInt(match[1], 10)
  const column = Number.parseInt(match[2], 10)
  if (row < 1 || column < 1) return null
  return { row, column }
}

/* ------------------------------------------------------------------ *
 * The body
 * ------------------------------------------------------------------ */

/**
 * @typedef {{tex: string, row: number, column: number}} Segment
 */

/**
 * Split a diagram body into cells, collecting the arrow commands as it goes.
 *
 * `&` and `\\` separate cells and rows, but only at brace depth zero and outside
 * any nested environment, so
 * `\begin{tikzcd} A & \begin{matrix} b & c \end{matrix} \end{tikzcd}` keeps the
 * inner matrix whole.
 *
 * @param {string} body
 * @param {ArrowSpec[]} arrows   Collected arrows, in source order.
 * @returns {Segment[]}
 */
function scanCells(body, arrows, spacing) {
  /** @type {Segment[]} */
  const segments = []
  /** @type {string[]} */
  const envStack = []
  let current = ''
  let row = 1
  let column = 1
  // PGF establishes a gap when its column boundary is first encountered.
  // Later rows cannot override it, even if the first row used the default.
  const establishedColumns = new Set()

  const flush = () => {
    segments.push({ tex: current, row, column })
    current = ''
  }

  let i = 0
  while (i < body.length) {
    const ch = body.charAt(i)

    if (ch === '\\') {
      // A row break, `\\`.
      if (body.charAt(i + 1) === '\\' && envStack.length === 0) {
        flush()
        row++
        column = 1
        i += 2
        while (/\s/.test(body.charAt(i)) && i < body.length) i++
        if (body.charAt(i) === '[') {
          spacing.row[row - 2] = groupBody(body, i)
          i = skipGroup(body, i)
        }
        continue
      }
      const begin = /^\\(begin|end)\s*\{([^}]*)\}/.exec(body.slice(i))
      if (begin) {
        if (begin[1] === 'begin') envStack.push(begin[2].trim())
        else if (envStack.length) envStack.pop()
        current += begin[0]
        i += begin[0].length
        continue
      }
      const arrow = envStack.length === 0 ? arrowCommandAt(body, i) : null
      if (arrow && arrow.matched) {
        // `arrowCommandAt` only matches `\arrow`/`\ar` here when a `[` follows the
        // name, so this search is bounded and cannot return -1.
        const bracketAt = body.indexOf('[', i + 1 + arrow.name.length)
        const optionsText = groupBody(body, bracketAt)
        let after = skipGroup(body, bracketAt)
        const labels = parseLabels(body, after)
        after = labels.end
        const spec = buildArrowSpec(arrow.name, optionsText, labels, {
          row,
          column,
        })
        arrows.push(spec)
        // An arrow written between two cells is anchored at the cell that follows
        // it, which is where tikz-cd puts it; the host is corrected in `flush`.
        // The cell keeps one space where the arrow was, so `A\arrow[r]B` does not
        // silently become the single token `AB`.
        current += ' '
        i = after
        continue
      }
      if (arrow) {
        // A bare `\rar`: the direction is in the name and there is nothing to read
        // after it.
        const spec = buildArrowSpec(
          arrow.name,
          '',
          { labels: [], placements: [] },
          { row, column },
        )
        arrows.push(spec)
        current += ' '
        i = i + 1 + arrow.name.length
        continue
      }
      // Any other control sequence: step over its name as one unit, so `\{` and
      // `\&` cannot be mistaken for structure.
      const name = /^\\(?:[a-zA-Z]+\*?|.)/.exec(body.slice(i))
      const length = name ? name[0].length : 2
      current += body.slice(i, i + length)
      i += length
      continue
    }

    if (ch === '{') {
      const end = skipGroup(body, i)
      current += body.slice(i, end)
      i = end
      continue
    }

    if (ch === '&' && envStack.length === 0) {
      flush()
      column++
      i++
      while (/\s/.test(body.charAt(i)) && i < body.length) i++
      if (body.charAt(i) === '[') {
        if (!establishedColumns.has(column - 2))
          spacing.column[column - 2] = groupBody(body, i)
        i = skipGroup(body, i)
      }
      establishedColumns.add(column - 2)
      continue
    }

    current += ch
    i++
  }
  flush()

  return segments
}

/**
 * Assemble an `ArrowSpec` from the pieces the scanner found.
 *
 * @param {string} command
 * @param {string} optionsText   The contents of the `[…]`, without its brackets.
 * @param {{labels: string[], placements: string[]}} trailing  Labels after the `]`.
 * @param {GridPos} host
 * @returns {ArrowSpec}
 */
function buildArrowSpec(command, optionsText, trailing, host) {
  const options = parseOptions(optionsText)
  const from = optionValue(options, 'from')
  const to = optionValue(options, 'to')
  const fromPos = typeof from === 'string' ? parseCellRef(from) : null
  const toPos = typeof to === 'string' ? parseCellRef(to) : null

  // The first option of an `\arrow[…]` may be a direction string rather than a
  // key: `\arrow[dr]` and `\arrow[dr, "f"]` both mean "down-right". A `\rar`-style
  // command carries its direction in its own name instead, and a bare `\arrow` —
  // or one that only names styles — means one step to the right, as the package
  // does.
  let direction = null
  if (
    options.length &&
    options[0][1] === true &&
    directionDelta(options[0][0])
  ) {
    direction = options[0][0]
  } else {
    direction = directionFromCommand(command)
  }

  let delta = null
  const loop = options.some(([key]) =>
    /^loop(?: (?:above|below|left|right))?$/.test(key),
  )
  if (loop) {
    delta = { dx: 0, dy: 0 }
  } else if (fromPos && toPos) {
    delta = { dx: toPos.column - fromPos.column, dy: toPos.row - fromPos.row }
  } else if (direction) {
    delta = directionDelta(direction)
  } else if (toPos) {
    delta = { dx: toPos.column - host.column, dy: toPos.row - host.row }
  } else if (fromPos) {
    // `from=` with no `to=` and no direction: the package still draws rightwards.
    delta = { dx: 1, dy: 0 }
  } else {
    direction = 'r'
    delta = { dx: 1, dy: 0 }
  }

  // Labels can be written inside the option brackets — `\ar[r,"f"]`, which is how
  // every real diagram writes them — or after them, `\ar[r]{f}{g}`. Both are kept,
  // in the order they appear, with the placement that belongs to each.
  const labels = []
  const labelPlacements = []
  for (const part of splitCommas(optionsText)) {
    const trimmed = part.trim()
    if (trimmed.charAt(0) !== '"') continue
    // The placement is part of this same comma-free part — `"f"'`, `"f"''` — or
    // the word after the quotes, which `parseOptions` keeps as its own entry.
    const quoted = unquote(part, part.indexOf('"'), true)
    labels.push(quoted.label)
    labelPlacements.push(quoted.placement)
  }
  for (let n = 0; n < labels.length; n++) {
    // `\ar[r,"f" below]` puts the placement in the same part as the label; the
    // part after the quotes is a separate, comma-free word, so it lands in
    // `options` rather than in a part of its own.
    if (labelPlacements[n]) continue
    for (const [key, value] of options) {
      if (value === true && PLACEMENTS.test(key)) {
        labelPlacements[n] = key
        break
      }
    }
  }
  for (let n = 0; n < trailing.labels.length; n++) {
    labels.push(trailing.labels[n])
    labelPlacements.push(trailing.placements[n])
  }

  return {
    host,
    from: fromPos,
    to: toPos,
    direction,
    delta: delta && (loop || delta.dx !== 0 || delta.dy !== 0) ? delta : null,
    labels,
    labelPlacements,
    options,
    command,
  }
}

/**
 * Read a whole `tikzcd` body.
 *
 * Never throws: an unreadable body comes back with `error` set and whatever cells
 * were found, so the caller can fall back to showing the source rather than
 * leaving a hole in the page.
 *
 * @param {string} rawBody
 * @returns {TikzcdBody}
 */
function parseTikzcd(rawBody) {
  /** @type {ArrowSpec[]} */
  const arrows = []
  const body = String(rawBody ?? '')

  // `\begin{tikzcd}[column sep=small]` — those options belong to the diagram.
  let rest = body
  let diagramOptions = ''
  const leading = /^\s*\[/.exec(rest)
  if (leading) {
    const at = leading[0].length - 1
    diagramOptions = groupBody(rest, at)
    rest = rest.slice(skipGroup(rest, at))
  }

  /** @type {Segment[]} */
  let segments
  const spacing = { row: {}, column: {} }
  try {
    segments = scanCells(rest, arrows, spacing)
  } catch (err) {
    return {
      cells: [],
      arrows: [],
      rows: 0,
      columns: 0,
      diagramOptions,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const all = segments.map((segment) => ({
    row: segment.row,
    column: segment.column,
    content: segment.tex.replace(/\s+/g, ' ').trim(),
  }))
  // A body with nothing in it is not a diagram — but an arrow-only body still is,
  // so the cells are kept as soon as one of them has content.
  const hasContent = all.some((cell) => cell.content !== '')
  const cells = hasContent ? all : []

  const rows = cells.reduce((max, cell) => Math.max(max, cell.row), 0)
  const columns = cells.reduce((max, cell) => Math.max(max, cell.column), 0)

  if (!rows || !columns) {
    return {
      cells,
      arrows,
      rows: 0,
      columns: 0,
      diagramOptions,
      error: 'empty diagram',
    }
  }

  return { cells, arrows, rows, columns, diagramOptions, spacing, error: null }
}

/* ------------------------------------------------------------------ *
 * Grid geometry — no MathJax, just arithmetic over measured cell sizes
 * ------------------------------------------------------------------ */

/**
 * Place the grid from MathJax's own measurements.
 *
 * MathJax lays the table out, so the column widths and row heights are its;
 * this turns them into cell boxes, which is what an arrow's endpoints are read
 * off. A column or row beyond the measured lists falls back to zero, so a
 * malformed grid degrades to a small cell rather than to `NaN`.
 *
 * @param {GridMetrics} metrics
 * @returns {GridLayout}
 */
function layoutGrid(metrics) {
  const columns = Math.max(1, metrics.columns)
  const rows = Math.max(1, metrics.rows)
  const widths = Array.from({ length: columns }, (_, i) =>
    Math.abs(metrics.columnWidths[i] ?? 0),
  )
  const heights = Array.from({ length: rows }, (_, i) =>
    Math.abs(metrics.rowHeights[i] ?? 0),
  )
  const depths = Array.from({ length: rows }, (_, i) =>
    Math.abs(metrics.rowDepths[i] ?? 0),
  )
  const baselines = Array.from(
    { length: rows },
    (_, i) => metrics.rowBaselines[i] ?? 0,
  )

  // Column edges, with the spacing that MathJax put between them.
  const lefts = []
  let x = 0
  for (let column = 0; column < columns; column++) {
    lefts.push(x)
    x += widths[column]
    if (column < columns - 1) x += metrics.columnSpacing
  }
  const width = x

  // Row edges. Rows hang from the baseline: the first row's top edge is its own
  // height above the baseline, and each row below starts one spacing further
  // down. `rowBaselines` is where MathJax put each row's own origin, which is
  // what a cell's contents are positioned against.
  const rowTop = baselines[0] + heights[0]
  const tops = []
  const bottoms = []
  let cursor = rowTop
  for (let row = 0; row < rows; row++) {
    tops.push(cursor)
    bottoms.push(cursor - heights[row] - depths[row])
    cursor = bottoms[row] - metrics.rowSpacing
  }

  /** @type {CellBox[]} */
  const boxes = []
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      boxes.push({
        row: row + 1,
        column: column + 1,
        left: lefts[column],
        right: lefts[column] + widths[column],
        top: tops[row],
        bottom: bottoms[row],
        width: widths[column],
        height: heights[row] + depths[row],
        baseline: baselines[row],
      })
    }
  }

  return { boxes, width, height: tops[0] ?? 0, depth: -bottoms[rows - 1] }
}

/**
 * The nine points of a cell box an arrow can be anchored to: its four corners,
 * the middle of each edge, and its centre.
 *
 * @param {CellBox} box
 * @returns {{left: number, center: number, right: number, top: number, middle: number, bottom: number}}
 */
function cellAnchors(box) {
  return {
    left: box.left,
    center: (box.left + box.right) / 2,
    right: box.right,
    top: box.top,
    middle: (box.top + box.bottom) / 2,
    bottom: box.bottom,
  }
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

/**
 * The whole parser, on the global.
 *
 * There is no `export` anywhere in this file, and that is deliberate. Chrome will
 * not run a file that contains one as a classic script — and a classic script is
 * the only way the extension beside it can load this file under the renderer's
 * `file://` protocol, where a dynamic `import()` of a `file:` URL is never
 * answered and a module script is blocked outright. So the file is written in the
 * subset both readers accept: classic JavaScript that assigns its functions to
 * `globalThis`, and which Node can still load with `import()` for the tests,
 * because `import()` of a module that exports nothing is legal and simply runs it.
 *
 * The list is written out rather than built from a registry so that a function
 * added above and forgotten here is a visible omission. Types live in
 * `tikzcd-parser.d.mts`.
 */
globalThis.__eukoliaTikzcdParser = {
  ARROW_COMMANDS,
  arrowCommandAt,
  cellAnchors,
  directionDelta,
  directionFromCommand,
  hasOption,
  layoutGrid,
  numberOption,
  optionValue,
  parseCellRef,
  parseOptions,
  parseTikzcd,
  skipGroup,
  splitCommas,
}
