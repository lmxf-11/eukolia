/*
 * Eukolia's port of the third-party `tikzcd` package to MathJax 4.
 *
 * `\begin{tikzcd}…\end{tikzcd}` is a graphics language, so this is not a macro
 * package. It reads the diagram, hands the grid to MathJax's own array
 * machinery, and draws the arrows — the one thing MathJax cannot express — into
 * the SVG that machinery produced. That is the pattern `amscd` established for a
 * commutative-diagram language, extended to arrows that run diagonally and
 * across cells.
 *
 *   tikzcd-parser.mjs   the syntax, with no MathJax in it at all (unit-tested)
 *   cells               the grid, as an ordinary `mtable` of `mtr`/`mtd` cells,
 *                       carrying the arrow list as a data attribute
 *   arrows              drawn by an SVG post-filter, once MathJax has laid the
 *                       grid out and the cell boxes are known
 *
 * Registration uses MathJax's ordinary TeX package lifecycle. The parser is
 * loaded lazily; retryAfter resumes the first diagram once it has arrived.
 */
;(function () {
  'use strict'

  var CONFIG = 'tikzcd'
  var ENVIRONMENT = 'tikzcd'
  /** The version of `public/mathjax/tex-svg.js` this extension is built against. */
  var MATHJAX_VERSION = '4.1.3'

  /**
   * A record of how far this file got.
   *
   * Leave it in. Every failure this extension has had reported the same thing —
   * "Unknown environment 'tikzcd'" — for causes as different as a token map that
   * was never registered, a package fetched but never joined to the parser, a
   * helper that threw before registering anything, and a startup held open waiting
   * for this very file. With no trace, each of those costs the same afternoon;
   * with this, the answer is one `describe` call away.
   */
  var grown =
    typeof globalThis !== 'undefined'
      ? (globalThis.__eukoliaTikzcd = { stages: [], errors: [], parser: false })
      : { stages: [], errors: [], parser: false }

  /** Note a step, so a failed load can be told from a load that never started. */
  function stage(name) {
    grown.stages.push(name)
  }
  grown.stages.push('evaluating')

  /* ---------------------------------------------------------------- *
   * Tuning. Layout values are in ems; the drawing values are in SVG
   * units, which are 1/1000 em (see `drawArrow`).
   * ---------------------------------------------------------------- */

  /** Space MathJax puts between columns and rows of the grid. */
  // tikzlibrarycd.code.tex: normal separation is between padded cell borders.
  var COLUMN_SPACING = 2.4
  var ROW_SPACING = 1.8
  /** How far an arrow stops short of the cell edge it points at, in ems. */
  var ARROW_INSET = 0.02
  /** SVG units per em. */
  var UNIT = 1000
  var ARROW_STROKE = 40
  var ARROW_INSET_UNITS = ARROW_INSET * UNIT
  var cellMetrics = new WeakMap()
  var labelMetrics = new WeakMap()
  var diagramBounds = new WeakMap()

  // tikzlibrarycd.code.tex v1.0, Augusto Stoffel (LPPL; see vendor notice).
  // Each named size scales the normal separation, independently for each axis.
  var SEPARATION_SIZES = {
    tiny: 0.25,
    small: 0.5,
    scriptsize: 0.75,
    normal: 1,
    large: 1.5,
    huge: 2,
  }

  function expandLength(value, texParser) {
    if (value.indexOf('\\') < 0) return value
    var TexParser = internals().input.tex.TexParser.default
    var mml = new TexParser(
      value,
      Object.assign({}, texParser.stack.env),
      texParser.configuration,
    ).mml()
    function text(node) {
      if (node.kind === 'text') return node.getText()
      if (
        !/^(?:math|mrow|inferredMrow|mi|mn|mo|mstyle|TeXAtom)$/.test(node.kind)
      )
        throw new Error('Unsupported tikzcd length expression: ' + value)
      return node.childNodes.map(text).join('')
    }
    return text(mml).replace(/−/g, '-')
  }

  function diagramSpacing(options, texParser, parsed) {
    var spacing = {
      row: ROW_SPACING + 'em',
      column: COLUMN_SPACING + 'em',
      origins: {},
    }
    var entries = parser.parseOptions(options || '')
    for (var i = 0; i < entries.length; i++) {
      var key = entries[i][0]
      if (key !== 'sep' && key !== 'row sep' && key !== 'column sep') continue
      var value = String(entries[i][1]).trim()
      var parts = parser.splitCommas(value),
        origin = false
      if (parts.length > 1) {
        if (
          parts.length !== 2 ||
          !/^between (origins|borders)$/.test(parts[1].trim())
        )
          throw new Error('Unsupported tikzcd ' + key + ': ' + value)
        origin = parts[1].trim() === 'between origins'
        value = parts[0].trim()
      }
      value = expandLength(value, texParser)
      var size = Object.prototype.hasOwnProperty.call(SEPARATION_SIZES, value)
        ? SEPARATION_SIZES[value]
        : null
      var length =
        /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(em|ex|pt|pc|in|cm|mm|bp|dd|cc|sp)$/.exec(
          value,
        )
      if (size === null && !length)
        throw new Error('Unsupported tikzcd ' + key + ': ' + value)
      var axes = key === 'sep' ? ['row', 'column'] : [key.split(' ')[0]]
      for (var a = 0; a < axes.length; a++) {
        var axis = axes[a]
        spacing.origins[axis] = origin
        if (size !== null) {
          spacing[axis] =
            size * (axis === 'row' ? ROW_SPACING : COLUMN_SPACING) + 'em'
        } else {
          // TeX absolute units at the standard 10pt design size. MathJax's cm/in
          // units otherwise use CSS pixels and change with the editor font size.
          var unit = length[2]
          var points = {
            pt: 1,
            pc: 12,
            in: 72.27,
            cm: 72.27 / 2.54,
            mm: 72.27 / 25.4,
            bp: 72.27 / 72,
            dd: 1238 / 1157,
            cc: (12 * 1238) / 1157,
            sp: 1 / 65536,
          }
          spacing[axis] =
            unit === 'em' || unit === 'ex'
              ? Number(length[1]) + unit
              : (Number(length[1]) * points[unit]) / 10 + 'em'
        }
      }
    }
    function em(value) {
      return parseFloat(value) * (value.endsWith('ex') ? 0.431 : 1)
    }
    if (parsed && parsed.spacing)
      ['row', 'column'].forEach(function (axis) {
        var count = (axis === 'row' ? parsed.rows : parsed.columns) - 1,
          values = []
        for (var index = 0; index < count; index++) {
          var extra = parsed.spacing[axis][index]
          var amount =
            extra === undefined
              ? 0
              : em(
                  diagramSpacing(axis + ' sep={' + extra + '}', texParser)[
                    axis
                  ],
                )
          values.push(em(spacing[axis]) + amount + 'em')
        }
        if (values.length) spacing[axis] = values.join(' ')
      })
    return spacing
  }

  /* ---------------------------------------------------------------- *
   * MathJax's internals
   * ---------------------------------------------------------------- */

  function internals() {
    var mj =
      typeof window !== 'undefined' && window.MathJax
        ? window.MathJax
        : globalThis.MathJax
    if (!mj || !mj._)
      throw new Error(CONFIG + ': MathJax is not available on this global')
    return mj._
  }

  // currentScript is only available during evaluation, not in a later promise.
  var parserUrl =
    typeof document !== 'undefined' && document.currentScript
      ? new URL('tikzcd-parser.mjs', document.currentScript.src).href
      : './tikzcd-parser.mjs'

  var parser = null
  var parserLoadError = null
  function loadParser() {
    if (parserPromise) return parserPromise
    parserPromise = (
      typeof document === 'undefined'
        ? import(/* @vite-ignore */ parserUrl)
        : new Promise(function (resolve, reject) {
            var script = document.createElement('script')
            script.src = parserUrl
            script.async = true
            script.onload = resolve
            script.onerror = function () {
              reject(new Error('Could not load ' + parserUrl))
            }
            document.head.append(script)
          })
    )
      .then(function () {
        parser = globalThis.__eukoliaTikzcdParser
        if (!parser)
          throw new Error('The tikzcd parser script did not register')
        grown.parser = true
        stage('parser-loaded')
        return parser
      })
      .catch(function (error) {
        parserLoadError = error
        grown.errors.push(String(error.message || error))
        stage('parser-missing')
        return null
      })
    return parserPromise
  }

  var parserPromise = null

  /* ---------------------------------------------------------------- *
   * Small helpers
   * ---------------------------------------------------------------- */

  function isTrue(value) {
    return value !== undefined && value !== false && value !== 'false'
  }

  function round(value) {
    return Math.round(value * 1000) / 1000
  }

  function optionNumber(options, name, fallback) {
    var wanted = String(name).toLowerCase()
    for (var i = 0; i < options.length; i++) {
      if (String(options[i][0]).toLowerCase() !== wanted) continue
      if (options[i][1] === true) return fallback
      var value = parseFloat(String(options[i][1]))
      return isFinite(value) ? value : fallback
    }
    return fallback
  }

  function hasOption(options, name) {
    var wanted = String(name).toLowerCase()
    for (var i = 0; i < options.length; i++) {
      if (String(options[i][0]).toLowerCase() === wanted)
        return isTrue(options[i][1])
    }
    return false
  }

  /* ---------------------------------------------------------------- *
   * Reading the environment
   * ---------------------------------------------------------------- */

  /**
   * The body of `\begin{tikzcd}…` up to the matching `\end{tikzcd}`, allowing for
   * environments nested inside it, plus the source that follows.
   *
   * @returns {{body: string, after: string}}
   */
  function readEnvironment(rest, name) {
    var i = 0
    while (i < rest.length && /\s/.test(rest.charAt(i))) i++

    // `\begin{tikzcd}[column sep=small]` — those options belong to the diagram.
    var options = ''
    if (rest.charAt(i) === '[') {
      var depth = 0
      var k = i
      while (k < rest.length) {
        var ch = rest.charAt(k)
        if (ch === '\\') {
          k += 2
          continue
        }
        if (ch === '{' || ch === '[') depth++
        else if (ch === '}' || ch === ']') {
          depth--
          if (depth === 0) break
        }
        k++
      }
      options = rest.slice(i, k + 1)
      i = k + 1
    }

    var nested = 0
    var cursor = i
    while (cursor < rest.length) {
      var tag = /^\\(begin|end)\s*\{([^}]*)\}/.exec(rest.slice(cursor))
      if (tag) {
        if (tag[2].trim() === name) {
          if (tag[1] === 'begin') nested++
          else if (nested === 0) {
            return {
              body: options + rest.slice(i, cursor),
              after: rest.slice(cursor + tag[0].length),
            }
          } else nested--
        }
        cursor += tag[0].length
        continue
      }
      cursor++
    }
    // Unterminated, which happens while a document is being typed: take the rest
    // and let the parser say what it can about it.
    return { body: options + rest.slice(i), after: '' }
  }

  /* ---------------------------------------------------------------- *
   * The TeX side: the grid, plus the arrow list it carries
   * ---------------------------------------------------------------- */

  /**
   * The arrow list, as JSON in a data attribute.
   *
   * A data attribute is the carrier because it is the one thing MathJax copies
   * from an MML node to the element it draws, and because the arrows can only be
   * placed after the grid has been laid out — by which point the TeX parse is
   * long over and there is nothing else left to read.
   */
  function encodeSpecs(arrows) {
    var out = []
    for (var i = 0; i < arrows.length; i++) {
      var spec = arrows[i]
      if (!spec.delta) continue
      out.push({
        k: i,
        f: spec.from || spec.host,
        d: spec.delta,
        t: spec.to,
        l: spec.labels,
        p: spec.labelPlacements,
        o: spec.options.map(function (pair) {
          return [pair[0], pair[1] === true ? 1 : pair[1]]
        }),
      })
    }
    try {
      return JSON.stringify(out)
    } catch (err) {
      return '[]'
    }
  }

  /**
   * The arrow list, read back out of its attribute.
   *
   * `encodeSpecs` writes the parser's own names into a short form so the list fits
   * in an attribute; this restores them, so nothing downstream has to remember that
   * `f` was `from` or that `d` is the two steps. Reading `d` as a pair — which a
   * first version did, having written it as an object — yields `undefined` for
   * every endpoint, and `NaN` for every coordinate: the arrow is drawn as a path of
   * `NaN`s, which serialises to nothing at all.
   */
  function decodeSpecs(text) {
    if (!text) return null
    try {
      var raw = JSON.parse(text)
      if (!raw || !raw.length) return null
      var specs = []
      for (var i = 0; i < raw.length; i++) {
        var spec = raw[i]
        if (!spec || !spec.f || !spec.d) continue
        specs.push({
          labelKey: spec.k,
          from: spec.f,
          to: spec.t || null,
          dx: spec.d.dx,
          dy: spec.d.dy,
          labels: spec.l || [],
          placements: spec.p || [],
          options: spec.o || [],
        })
      }
      return specs.length ? specs : null
    } catch (err) {
      return null
    }
  }

  /* ---------------------------------------------------------------- *
   * The environment handler — synchronous, always
   * ---------------------------------------------------------------- */

  /**
   * The `tikzcd` environment, in the shape MathJax's environment protocol wants.
   *
   * Three things about this shape were each a wrong turn first, and all three fail
   * as something that reads like a different problem:
   *
   *   * The map is built with `ParseMethods.environment`, the shared wrapper every
   *     environment in the distribution goes through. That wrapper makes the
   *     opening `begin` item, calls the environment's own method with it, and
   *     pushes what comes back — which is why this signature is `(parser, begin)`
   *     and the name has to be read off the item.
   *   * The method's job is only to open the environment: it returns a stack
   *     *item* for the closing `\end{tikzcd}` to match. An environment that returns
   *     a finished node leaves the close with nothing to find, and the parser then
   *     reports "Unknown environment" for a diagram it has already read.
   *   * The item is an ordinary `ArrayItem`, and the diagram is handed to it the
   *     way `array` hands over its body: by rewriting the parser's string so the
   *     engine reads the cells itself. Building the cells here instead and pushing
   *     them by hand does not work — the entries have to be made by the engine
   *     that is also going to close the table.
   *
   * @returns {object} The array item that becomes the grid.
   */
  function TikzcdEnvironment(texParser, begin) {
    // The environment's own name, from the opening item — `ParseMethods.environment`
    // passes the item, not the name.
    var name = begin && begin.getName ? begin.getName() : ENVIRONMENT
    if (begin && begin.kind) texParser.Push(begin)

    var rest = String(texParser.string).slice(texParser.i)
    var read = readEnvironment(rest, name)

    if (!parser) {
      // Do not retry a settled failure: that creates an endless microtask loop.
      if (parserLoadError)
        return fail('the tikzcd extension could not load its parser')
      internals().mathjax.mathjax.retryAfter(loadParser())
      return null
    }

    function fail(message) {
      texParser.string = read.after
      texParser.i = 0
      return texParser.create(
        'node',
        'merror',
        [
          texParser.create(
            'text',
            '\\begin{' + name + '}' + read.body + '\\end{' + name + '}',
          ),
        ],
        { 'data-mjx-error': message },
      )
    }

    // An empty body is a diagram with nothing in it, which is what `\begin{tikzcd}`
    // followed straight by `\end{tikzcd}` means — not a TeX error. This is the shape
    // an editor passes through on the way to a real diagram, so it becomes an empty
    // grid. The closing tag has to be left for the parser to read, though: it is
    // what closes the opening item, and swallowing it here is what leaves the parser
    // reporting `Missing \end{tikzcd}` for a diagram that had one.
    if (!read.body.trim()) {
      texParser.string = '\\end{' + name + '}' + read.after
      texParser.i = 0
      var empty = texParser.itemFactory.create('array')
      empty.arraydef = { columnalign: 'center' }
      return empty
    }

    var parsed = parser.parseTikzcd(read.body)
    if (parsed.error || !parsed.rows || !parsed.columns) {
      // The author sees their own diagram rather than an error box: an unreadable
      // body is still their source, and hiding it hides their work.
      return fail(parsed.error || 'empty tikzcd diagram')
    }
    var spacing
    try {
      spacing = diagramSpacing(parsed.diagramOptions, texParser, parsed)
    } catch (error) {
      throw new (internals().input.tex.TexError.default)(
        'TikzcdSpacing',
        error.message,
      )
    }
    parsed.arrows.forEach(function (arrow) {
      arrow.options = arrow.options.map(function (e) {
        if (
          e[1] !== true &&
          /^(shift left|shift right|min distance|out distance|in distance|shorten <|shorten >)$/.test(
            e[0],
          )
        )
          return [e[0], expandLength(String(e[1]), texParser)]
        return e
      })
    })

    // What MathJax would have read after `\end{tikzcd}`. **It has to be put back:**
    // the rebuilt source below replaces the parser's string, and dropping this
    // discards whatever followed the diagram in the surrounding mathematics — and,
    // because the `\end{tikzcd}` that closes this item is part of the rebuilt
    // string, dropping it makes the item report `Missing \end{tikzcd}` for a
    // diagram that has one. That is a MathJax error box, which is exactly the
    // outcome this port exists to remove. It went unnoticed while the tests ran
    // first with other mathematics, and showed up the moment a `tikzcd` was the
    // first thing a fresh typesetter was asked for.
    var tail = read.after

    // Hand the cells to the engine, which is the only thing that can make the
    // entries and then close them. The source is rebuilt from the cells the parser
    // module produced, with the arrow commands removed and a bare `&`/`\\`
    // structure, and the trailing `\end{tikzcd}` is the close this item will match.
    var rows = []
    for (var row = 1; row <= parsed.rows; row++) {
      var cells = []
      for (var column = 1; column <= parsed.columns; column++) {
        var content = ''
        for (var c = 0; c < parsed.cells.length; c++) {
          if (
            parsed.cells[c].row === row &&
            parsed.cells[c].column === column
          ) {
            content = parsed.cells[c].content
            break
          }
        }
        cells.push(content)
      }
      rows.push(cells.join(' & '))
    }
    // `\\` here is a *single* row break in the source the parser will read, so the
    // JavaScript literal has to carry two backslashes for each one written.
    texParser.string = rows.join(' \\\\ ') + '\\end{' + name + '}' + tail
    texParser.i = 0

    var item = texParser.itemFactory.create('array')
    item.arraydef = {
      columnalign: 'center',
      columnspacing: spacing.column,
      rowspacing: spacing.row,
    }
    // Parse labels with the same macro environment and configuration as the cells.
    // Keep them in zero-size holders until SVG output positions them on the arrows.
    var labelNodes = []
    var TexParser = internals().input.tex.TexParser.default
    for (var a = 0; a < parsed.arrows.length; a++) {
      var labels = parsed.arrows[a].labels || []
      for (var l = 0; l < labels.length; l++) {
        var math = new TexParser(
          '\\scriptstyle ' + labels[l],
          Object.assign({}, texParser.stack.env),
          texParser.configuration,
        ).mml()
        var styled = texParser.create('node', 'mstyle', [math], {
          scriptlevel: 1,
          displaystyle: false,
          'data-tikzcd-label-content': a + ':' + l,
          'data-tikzcd-label-tex': labels[l],
        })
        labelNodes.push(
          texParser.create('node', 'mpadded', [styled], {
            width: '0',
            height: '0',
            depth: '0',
            style: 'visibility:hidden',
          }),
        )
      }
    }
    var specs = encodeSpecs(parsed.arrows)

    // `createMml` is where the array becomes a table, and the arrow list goes on
    // it there: that node is the one the output filter will be shown, and there is
    // no other channel from this parse to that one.
    var createMml = item.createMml
    item.createMml = function () {
      var node = createMml.call(this)
      if (node && node.attributes) {
        // TikZ-CD pads every node by 1ex horizontally and .85ex vertically.
        // Let MathJax resolve ex in the active font and include that padding in
        // the table metrics, rather than drawing arrows into unreserved space.
        node.setProperty('useHeight', false)
        for (var r = 0; r < node.childNodes.length; r++) {
          var row = node.childNodes[r]
          for (var c = 0; c < row.childNodes.length; c++) {
            var cell = row.childNodes[c]
            var content = cell.childNodes[0].childNodes.slice()
            var padded = texParser.create('node', 'mpadded', content, {
              width: '+2ex',
              height: '+0.85ex',
              depth: '+0.85ex',
              lspace: '1ex',
            })
            cell.setChildren([padded])
          }
        }
        var firstCell = node.childNodes[0] && node.childNodes[0].childNodes[0]
        if (firstCell)
          labelNodes.forEach(function (label) {
            firstCell.appendChild(label)
          })
        node.attributes.set(
          'data-tikzcd-grid',
          parsed.rows + 'x' + parsed.columns,
        )
        node.attributes.set('data-tikzcd-specs', specs)
        node.attributes.set(
          'data-tikzcd-origin-spacing',
          JSON.stringify(spacing.origins),
        )
      }
      return texParser.create('node', 'mpadded', [node], {
        'data-tikzcd-label-bounds': '1',
      })
    }
    return item
  }

  /* ---------------------------------------------------------------- *
   * Geometry, from the SVG MathJax drew
   * ---------------------------------------------------------------- */

  /**
   * The cell boxes of one diagram, in SVG units.
   *
   * MathJax has already placed every cell: each row's `<g data-mml-node="mtr">`
   * carries the `translate` that puts its baseline where it belongs, and each
   * cell's `<g data-mml-node="mtd">` carries the one that puts its content where
   * it belongs. Reading those, rather than recomputing them, is what keeps an
   * arrow's ends on the cell edges MathJax actually drew.
   */
  function measureSvg(adaptor, grid) {
    var transforms = []
    var glyphs = indexGlyphs(adaptor, grid)
    collectTransforms(adaptor, grid, transforms, null, glyphs)

    var cells = []
    var rowMarks = []
    for (var i = 0; i < transforms.length; i++) {
      var entry = transforms[i]
      if (entry.kind === 'mtd') cells.push(entry)
      else rowMarks.push(entry)
    }
    if (!rowMarks.length || !cells.length) return null

    // The cells as MathJax placed them, grouped by the row they were collected in.
    var byRow = {}
    for (var c = 0; c < cells.length; c++) {
      var key = cells[c].row
      if (!byRow[key]) byRow[key] = []
      byRow[key].push(cells[c])
    }
    var rowKeys = Object.keys(byRow)
    var numRows = rowKeys.length
    var numColumns = 0
    for (var k = 0; k < rowKeys.length; k++) {
      numColumns = Math.max(numColumns, byRow[rowKeys[k]].length)
    }
    if (!numRows || !numColumns) return null

    // Cell boxes are taken verbatim from where MathJax put them: an arrow's ends
    // are on the edges of the boxes the glyphs were actually drawn in, so
    // recomputing a box from a column width is a way to be off by the difference.
    var boxes = {}
    for (var k2 = 0; k2 < rowKeys.length; k2++) {
      var rowCells = byRow[rowKeys[k2]]
      var rowIndex = rowMarks[k2] ? rowMarks[k2].row : k2 + 1
      for (var n = 0; n < rowCells.length; n++) {
        var cell = rowCells[n]
        // SVG table translations are already in MathJax's local y-up space.
        // TikZ-CD's asymmetric rectangle anchors horizontal arrows on the math
        // axis, while vertical arrows meet the padded top/bottom cell borders.
        var middle = cell.y + UNIT / 4
        boxes[rowIndex + '-' + (n + 1)] = {
          row: rowIndex,
          column: n + 1,
          left: cell.x,
          right: cell.x + cell.width,
          top: cell.y + cell.ascent,
          bottom: cell.y - cell.depth,
          width: cell.width,
          height: cell.height,
          baseline: middle,
        }
      }
    }

    return {
      boxes: boxes,
      rows: numRows,
      columns: numColumns,
    }
  }

  /**
   * Find the `mtr`/`mtd` groups under `node`, with the absolute translation each
   * one is placed at, flattening nested transforms as it goes.
   *
   * MathJax places every cell absolutely and never says which column it is in, so
   * the cell number is counted here: a cell's column is the one after the cell
   * before it in the same row. Counting it wrongly is invisible in a one-row
   * diagram with one arrow — the arrow is simply drawn between two cells that
   * think they are the same one, which is zero-length and skipped.
   */
  function collectTransforms(adaptor, node, out, state, glyphs) {
    state = state || { x: 0, y: 0, row: 0, column: 0 }
    var children = childElements(adaptor, node)
    for (var i = 0; i < children.length; i++) {
      var child = children[i]
      if (adaptor.kind(child) !== 'g') {
        collectTransforms(adaptor, child, out, state, glyphs)
        continue
      }
      var node_ = adaptor.getAttribute(child, 'data-mml-node')
      var here = {
        x: state.x,
        y: state.y,
        row: state.row,
        column: state.column,
      }
      var moved = parseTranslate(adaptor.getAttribute(child, 'transform'))
      here.x += moved.x
      here.y += moved.y

      if (node_ === 'mtr') {
        here.row =
          out.filter(function (entry) {
            return entry.kind === 'mtr'
          }).length + 1
        here.column = 0
        out.push({ kind: 'mtr', x: here.x, y: here.y, row: here.row })
      } else if (node_ === 'mtd') {
        here.column += 1
        var box = contentBox(adaptor, child, glyphs)
        out.push({
          kind: 'mtd',
          x: here.x,
          y: here.y,
          row: here.row,
          column: here.column,
          width: box.width,
          height: box.height,
          ascent: box.ascent === undefined ? box.height : box.ascent,
          depth: box.depth || 0,
        })
        // Tables inside a cell belong to its mathematics, not to this grid.
        continue
      }
      collectTransforms(adaptor, child, out, here, glyphs)
    }
  }

  /**
   * The element children of a node.
   *
   * `adaptor.childNodes` includes text nodes, which have no children of their own
   * and throw when they are walked — under LiteDOM as "children is not iterable".
   */
  function childElements(adaptor, node) {
    var out = []
    var children
    try {
      children = adaptor.childNodes(node)
    } catch (err) {
      return out
    }
    if (!children) return out
    for (var i = 0; i < children.length; i++) {
      var kind = adaptor.kind(children[i])
      if (kind !== '#text' && kind !== '#comment') out.push(children[i])
    }
    return out
  }

  /** `translate(x,y)` out of a transform attribute. */
  function parseTranslate(transform) {
    var match = /translate\(\s*(-?[\d.]+)(?:[,\s]+(-?[\d.]+))?\s*\)/.exec(
      transform || '',
    )
    if (!match) return { x: 0, y: 0 }
    return { x: parseFloat(match[1]) || 0, y: parseFloat(match[2]) || 0 }
  }

  /**
   * The width and height of a cell's content, from the boxes MathJax drew.
   *
   * Every glyph in the SVG output is a `<use>` referring to a `<path>` in the
   * document's `<defs>`. The cell has no rectangle of its own — an array cell is
   * not framed — so the content's box is the union of its glyphs.
   *
   * @param {object} glyphs  Character boxes, keyed by path id; see `indexGlyphs`.
   */
  function contentBox(adaptor, cell, glyphs) {
    var measured = cellMetrics.get(cell)
    if (measured) return measured
    var width = 0
    var height = 0
    var kids = childElements(adaptor, cell)
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i]
      var kind = adaptor.kind(kid)
      if (kind === 'use') {
        var box = useBox(adaptor, kid, glyphs)
        width += box.width
        if (box.height > height) height = box.height
      } else if (kind === 'rect') {
        var w = parseFloat(adaptor.getAttribute(kid, 'width')) || 0
        var h = parseFloat(adaptor.getAttribute(kid, 'height')) || 0
        width += w
        if (h > height) height = h
      } else if (kind === 'g' || kind === 'svg') {
        var inner = contentBox(adaptor, kid, glyphs)
        width += inner.width
        if (inner.height > height) height = inner.height
      } else if (kind === 'text') {
        var text = adaptor.textContent(kid) || ''
        width += text.length * LABEL_CHAR_WIDTH * UNIT
        if (height < 0.6 * UNIT) height = 0.6 * UNIT
      }
    }
    // A cell with no content still needs room for an arrow to attach to.
    if (!width) width = 0.3 * UNIT
    return { width: width, height: Math.max(height, 0.7 * UNIT) }
  }

  /**
   * Every character box in the document, keyed by the id its `<use>` refers to.
   *
   * Built once per diagram: the alternative is searching the whole SVG for each
   * glyph, and character paths repeat, so the same few hundred ids would be found
   * over and over.
   */
  function indexGlyphs(adaptor, container) {
    var boxes = {}
    var walk = function (node) {
      var kids = childElements(adaptor, node)
      for (var i = 0; i < kids.length; i++) {
        var kid = kids[i]
        var id = adaptor.getAttribute(kid, 'id')
        if (id && adaptor.kind(kid) === 'path') {
          boxes[id] = pathBox(adaptor.getAttribute(kid, 'd'))
        }
        walk(kid)
      }
    }
    // The definitions live outside the container in the browser DOM and inside it
    // under LiteDOM, so both are searched.
    walk(container)
    var root = adaptor.root ? adaptor.root(container) : null
    if (root && root !== container) walk(root)
    return boxes
  }

  /**
   * The width and height of a font character, from the path data its `<use>`
   * refers to: the path is in a 1000-unit em, so its own bounding box is the
   * character's box.
   */
  function useBox(adaptor, use, glyphs) {
    var href =
      adaptor.getAttribute(use, 'xlink:href') ||
      adaptor.getAttribute(use, 'href') ||
      adaptor.getAttribute(use, 'data-c') ||
      ''
    var id = String(href).replace(/^#/, '')
    var box = id && glyphs ? glyphs[id] : null
    if (box && box.width) return box
    // An unknown character still needs a plausible box: a cell that measures zero
    // would put the arrow inside the letter.
    return { width: 0.5 * UNIT, height: 0.7 * UNIT }
  }

  /**
   * The bounding box of an SVG path's `d`, well enough for a font glyph.
   *
   * Only the absolute and relative moves, lines and curves appear in MathJax's
   * character paths; the control points of a curve are counted, which
   * over-estimates a glyph slightly and never under-estimates it — the safe
   * direction, because an under-estimated cell puts the arrow inside a letter.
   */
  function pathBox(d) {
    var minX = Infinity
    var maxX = -Infinity
    var minY = Infinity
    var maxY = -Infinity
    var x = 0
    var y = 0
    var startX = 0
    var startY = 0
    var tokens =
      String(d).match(/[MmLlHhVvCcSsQqTtAaZz]|-?[\d.]+(?:e-?\d+)?/g) || []
    var command = 'M'
    var args = []
    var read = function (n) {
      var values = []
      for (var i = 0; i < n && args.length; i++)
        values.push(parseFloat(args.shift()))
      return values
    }
    var include = function (px, py) {
      if (!isFinite(px) || !isFinite(py)) return
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
    include(0, 0)
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i]
      if (/[A-Za-z]/.test(token)) {
        command = token
        args = []
        continue
      }
      args.push(token)
      var relative = command === command.toLowerCase()
      var n = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }[
        command.toLowerCase()
      ]
      if (n === undefined) {
        args = []
        continue
      }
      while (args.length >= n) {
        var v = read(n)
        if (n === 0) break
        switch (command.toLowerCase()) {
          case 'm':
          case 'l':
          case 't':
            x = relative ? x + v[0] : v[0]
            y = relative ? y + v[1] : v[1]
            if (command.toLowerCase() === 'm') {
              command = relative ? 'l' : 'L'
              startX = x
              startY = y
            }
            include(x, y)
            break
          case 'h':
            x = relative ? x + v[0] : v[0]
            include(x, y)
            break
          case 'v':
            y = relative ? y + v[0] : v[0]
            include(x, y)
            break
          case 'c':
            include(relative ? x + v[0] : v[0], relative ? y + v[1] : v[1])
            include(relative ? x + v[2] : v[2], relative ? y + v[3] : v[3])
            x = relative ? x + v[4] : v[4]
            y = relative ? y + v[5] : v[5]
            include(x, y)
            break
          case 's':
          case 'q':
            include(relative ? x + v[0] : v[0], relative ? y + v[1] : v[1])
            x = relative ? x + v[2] : v[2]
            y = relative ? y + v[3] : v[3]
            include(x, y)
            break
          case 'a':
            include(relative ? x + v[5] : v[5], relative ? y + v[6] : v[6])
            x = relative ? x + v[5] : v[5]
            y = relative ? y + v[6] : v[6]
            include(x, y)
            break
        }
      }
      void startX
      void startY
    }
    if (!isFinite(minX) || !isFinite(maxX))
      return { width: 0.5 * UNIT, height: 0.7 * UNIT }
    return {
      width: Math.max(maxX - minX, 0),
      height: Math.max(maxY - minY, 0.2 * UNIT),
    }
  }

  /* ---------------------------------------------------------------- *
   * Drawing
   * ---------------------------------------------------------------- */

  /** A point on a cell's edge: `t` runs 0 to 1 across it, bottom or left to top or right. */
  function anchor(box, side, t) {
    if (side === 'left' || side === 'right') {
      return {
        x: side === 'left' ? box.left : box.right,
        y: t === 0.5 ? box.baseline : box.bottom + (box.top - box.bottom) * t,
      }
    }
    return {
      x: box.left + (box.right - box.left) * t,
      y: side === 'top' ? box.top : box.bottom,
    }
  }

  /**
   * The box of the cell an arrow points at, or a cell-sized space just beyond the
   * grid's edge when the arrow leaves the diagram.
   */
  function targetBox(layout, source, targetPos) {
    var inside = layout.boxes[targetPos.row + '-' + targetPos.column]
    if (inside) return inside
    var gap = COLUMN_SPACING * UNIT
    var rowGap = ROW_SPACING * UNIT
    return {
      row: targetPos.row,
      column: targetPos.column,
      left:
        source.left + (targetPos.column - source.column) * (source.width + gap),
      right:
        source.right +
        (targetPos.column - source.column) * (source.width + gap),
      top: source.top + (source.row - targetPos.row) * (source.height + rowGap),
      bottom:
        source.bottom + (source.row - targetPos.row) * (source.height + rowGap),
      width: source.width,
      height: source.height,
      baseline:
        source.baseline +
        (source.row - targetPos.row) * (source.height + rowGap),
    }
  }

  /** Pull both ends of a segment back along its own direction. */
  function inset(from, to, amount) {
    var vx = to.x - from.x
    var vy = to.y - from.y
    var length = Math.sqrt(vx * vx + vy * vy)
    if (!length)
      return {
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
        ux: 1,
        uy: 0,
        length: 0,
      }
    var ux = vx / length
    var uy = vy / length
    return {
      x1: from.x + ux * amount,
      y1: from.y + uy * amount,
      x2: to.x - ux * amount,
      y2: to.y - uy * amount,
      ux: ux,
      uy: uy,
      length: Math.max(0, length - 2 * amount),
    }
  }

  /**
   * Where an arrow starts and ends: on the edge of the cell it leaves and the one
   * it enters, inset a little so the head does not touch the lettering.
   *
   * Diagonals intersect the asymmetric node border along the center-to-center ray.
   */
  function arrowEnds(source, target, dx, dy) {
    var start
    var end
    if (dx !== 0 && dy !== 0) {
      var vx = (target.left + target.right - source.left - source.right) / 2
      var vy = target.baseline - source.baseline
      var length = Math.hypot(vx, vy) || 1
      start = borderPoint(source, vx / length, vy / length)
      end = borderPoint(target, -vx / length, -vy / length)
      return inset(start, end, 0)
    } else if (dx !== 0) {
      start = anchor(source, dx > 0 ? 'right' : 'left', 0.5)
      end = anchor(target, dx > 0 ? 'left' : 'right', 0.5)
    } else {
      start = anchor(source, dy > 0 ? 'bottom' : 'top', 0.5)
      end = anchor(target, dy > 0 ? 'top' : 'bottom', 0.5)
    }
    return inset(start, end, ARROW_INSET_UNITS)
  }

  /** The arrowhead at `(x, y)` pointing along `(ux, uy)`, as a path. */
  function headPath(x, y, ux, uy) {
    // Computer Modern Rightarrow geometry, adapted from PGF arrows.meta
    // (Copyright 2018 Till Tantau, LPPL; see vendor-licenses/pgf-arrow-NOTICE.txt).
    // tikz-cd's cm to uses length = 6.2 * rule_thickness and an open tip.
    var length = 5.2 * ARROW_STROKE
    var width = (6.2 * 2.096774 - 1) * ARROW_STROKE
    function point(along, across) {
      return (
        round(x + ux * along - uy * across) +
        ' ' +
        round(y + uy * along + ux * across)
      )
    }
    return (
      'M' +
      point(-length, width / 2) +
      'C' +
      point(-0.81731 * length, 0.2 * width) +
      ' ' +
      point(-0.41019 * length, 0.05833333 * width) +
      ' ' +
      point(0, 0) +
      'C' +
      point(-0.41019 * length, -0.05833333 * width) +
      ' ' +
      point(-0.81731 * length, -0.2 * width) +
      ' ' +
      point(-length, -width / 2)
    )
  }

  /** The shaft, straight or bent, as a path. */
  function shaftPath(ends, bend) {
    if (!bend) {
      return (
        'M' +
        round(ends.x1) +
        ' ' +
        round(ends.y1) +
        'L' +
        round(ends.x2) +
        ' ' +
        round(ends.y2)
      )
    }
    var mx = (ends.x1 + ends.x2) / 2
    var my = (ends.y1 + ends.y2) / 2
    var px = -ends.uy * bend
    var py = ends.ux * bend
    return (
      'M' +
      round(ends.x1) +
      ' ' +
      round(ends.y1) +
      'Q' +
      round(mx + px) +
      ' ' +
      round(my + py) +
      ' ' +
      round(ends.x2) +
      ' ' +
      round(ends.y2)
    )
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value))
  }

  /** `shift left=1` / `shift right=1`, in ems, perpendicular to the arrow. */
  function shiftOffset(options) {
    var result = 0
    options.forEach(function (e) {
      if (e[0] !== 'shift left' && e[0] !== 'shift right') return
      var value = e[1] === true ? '1' : String(e[1])
      var amount = /^[+-]?[\d.]+$/.test(value)
        ? Number(value) * 0.56 * 0.431
        : lengthEm(value)
      result = (e[0] === 'shift left' ? 1 : -1) * amount * UNIT
    })
    return result
  }

  function lengthEm(value) {
    var text = diagramSpacing('sep={' + value + '}', null).row
    return parseFloat(text) * (text.endsWith('ex') ? 0.431 : 1)
  }

  function borderPoint(box, ux, uy) {
    var cx = (box.left + box.right) / 2,
      cy = box.baseline
    var d = Math.min(
      (box.right - box.left) / 2 / Math.max(Math.abs(ux), 1e-8),
      (uy > 0 ? box.top - cy : cy - box.bottom) / Math.max(Math.abs(uy), 1e-8),
    )
    return {
      x: cx + ux * (d + ARROW_INSET_UNITS),
      y: cy + uy * (d + ARROW_INSET_UNITS),
    }
  }

  function curvedEnds(source, target, options, angle) {
    var direction = Math.atan2(
      target.baseline - source.baseline,
      (target.left + target.right - source.left - source.right) / 2,
    )
    var out = hasOption(options, 'out')
      ? (optionNumber(options, 'out', 0) * Math.PI) / 180
      : direction + angle
    var incoming = hasOption(options, 'in')
      ? (optionNumber(options, 'in', 180) * Math.PI) / 180
      : direction + Math.PI - angle
    var a = borderPoint(source, Math.cos(out), Math.sin(out)),
      b = borderPoint(target, Math.cos(incoming), Math.sin(incoming))
    var chord = Math.hypot(b.x - a.x, b.y - a.y),
      distance = 0.3915 * chord * optionNumber(options, 'looseness', 1)
    return {
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      ux: (b.x - a.x) / chord,
      uy: (b.y - a.y) / chord,
      length: chord,
      controls: [
        a.x + Math.cos(out) * distance,
        a.y + Math.sin(out) * distance,
        b.x + Math.cos(incoming) * distance,
        b.y + Math.sin(incoming) * distance,
      ],
    }
  }

  // TikZ-CD arrow keys are case-sensitive and execute from left to right.
  // In particular, Rightarrow means a double shaft, not two opposed heads.
  function arrowStyle(options) {
    var style = { start: null, end: 'to', doubleLine: false, dashed: false }
    for (var i = 0; i < options.length; i++) {
      var key = options[i][0]
      switch (key) {
        case 'rightarrow':
          style.start = null
          style.end = 'to'
          break
        case 'leftarrow':
          style.start = 'to'
          style.end = null
          break
        case 'leftrightarrow':
          style.start = style.end = 'to'
          break
        case 'Rightarrow':
          style.doubleLine = true
          style.start = null
          style.end = 'implies'
          break
        case 'Leftarrow':
          style.doubleLine = true
          style.start = 'implies'
          style.end = null
          break
        case 'Leftrightarrow':
          style.doubleLine = true
          style.start = style.end = 'implies'
          break
        case 'two heads':
          style.end = 'double'
          break
        case 'twoheadrightarrow':
          style.start = null
          style.end = 'double'
          break
        case 'twoheadleftarrow':
          style.start = 'double'
          style.end = null
          break
        case 'no head':
          style.end = null
          break
        case 'no tail':
          style.start = null
          break
        case 'to head':
          style.end = 'to'
          break
        case 'equal':
        case 'equals':
          style.doubleLine = true
          style.start = style.end = null
          break
        case 'dash':
          style.start = style.end = null
          break
        case 'double line':
          style.doubleLine = true
          break
        case 'dashed':
          style.dashed = true
          break
        case 'dashrightarrow':
          style.start = null
          style.end = 'to'
          style.dashed = true
          break
        case 'dashleftarrow':
          style.start = 'to'
          style.end = null
          style.dashed = true
          break
        case 'mapsto':
          style.start = 'bar'
          style.end = 'to'
          break
        case 'mapsfrom':
          style.start = 'to'
          style.end = 'bar'
          break
        case 'Mapsto':
          style.doubleLine = true
          style.start = 'bar'
          style.end = 'implies'
          break
        case 'Mapsfrom':
          style.doubleLine = true
          style.start = 'implies'
          style.end = 'bar'
          break
        case 'maps to':
          style.start = 'bar'
          break
        case 'hook':
          style.start = 'hook-right'
          break
        case "hook'":
          style.start = 'hook-left'
          break
        case 'hookrightarrow':
          style.start = 'hook-right'
          style.end = 'to'
          break
        case 'hookleftarrow':
          style.start = 'to'
          style.end = 'hook-left'
          break
        case 'harpoon':
          style.end = 'harpoon-left'
          break
        case "harpoon'":
          style.end = 'harpoon-right'
          break
        case 'rightharpoonup':
          style.start = null
          style.end = 'harpoon-left'
          break
        case 'rightharpoondown':
          style.start = null
          style.end = 'harpoon-right'
          break
        case 'leftharpoonup':
          style.start = 'harpoon-right'
          style.end = null
          break
        case 'leftharpoondown':
          style.start = 'harpoon-left'
          style.end = null
          break
        case 'tail':
          style.start = 'reversed'
          break
        case 'rightarrowtail':
          style.start = 'reversed'
          style.end = 'to'
          break
        case 'leftarrowtail':
          style.start = 'to'
          style.end = 'reversed'
          break
      }
    }
    return style
  }

  // PGF's Implies tip, expressed relative to the visible tip. Draw two separate
  // stems instead of painting over a thick shaft with a background colour.
  var DOUBLE_LINE_DISTANCE = 0.45 * 0.431 * UNIT
  function impliesPath(x, y, ux, uy) {
    var q = DOUBLE_LINE_DISTANCE / 2
    function point(along, across) {
      return (
        round(x + ux * along * q - uy * across * q) +
        ' ' +
        round(y + uy * along * q + ux * across * q)
      )
    }
    return (
      'M' +
      point(-3.4, 2.65) +
      'C' +
      point(-2.75, 1.25) +
      ' ' +
      point(-1, 0.05) +
      ' ' +
      point(0, 0) +
      'C' +
      point(-1, -0.05) +
      ' ' +
      point(-2.75, -1.25) +
      ' ' +
      point(-3.4, -2.65)
    )
  }

  function curvePoint(ends, bend, t) {
    var u = 1 - t,
      x,
      y,
      dx,
      dy
    if (ends.controls) {
      var c = ends.controls
      x =
        u * u * u * ends.x1 +
        3 * u * u * t * c[0] +
        3 * u * t * t * c[2] +
        t * t * t * ends.x2
      y =
        u * u * u * ends.y1 +
        3 * u * u * t * c[1] +
        3 * u * t * t * c[3] +
        t * t * t * ends.y2
      dx =
        3 * u * u * (c[0] - ends.x1) +
        6 * u * t * (c[2] - c[0]) +
        3 * t * t * (ends.x2 - c[2])
      dy =
        3 * u * u * (c[1] - ends.y1) +
        6 * u * t * (c[3] - c[1]) +
        3 * t * t * (ends.y2 - c[3])
    } else {
      var cx = (ends.x1 + ends.x2) / 2 - ends.uy * bend,
        cy = (ends.y1 + ends.y2) / 2 + ends.ux * bend
      x = u * u * ends.x1 + 2 * u * t * cx + t * t * ends.x2
      y = u * u * ends.y1 + 2 * u * t * cy + t * t * ends.y2
      dx = 2 * u * (cx - ends.x1) + 2 * t * (ends.x2 - cx)
      dy = 2 * u * (cy - ends.y1) + 2 * t * (ends.y2 - cy)
    }
    var length = Math.hypot(dx, dy) || 1
    return { x: x, y: y, ux: dx / length, uy: dy / length }
  }

  function loopEnds(source, options) {
    var side = 'above'
    options.forEach(function (e) {
      if (/^loop (above|below|left|right)$/.test(e[0])) side = e[0].slice(5)
    })
    var angles = {
      above: [105, 75],
      below: [285, 255],
      left: [195, 165],
      right: [15, -15],
    }[side]
    var out = (optionNumber(options, 'out', angles[0]) * Math.PI) / 180,
      incoming = (optionNumber(options, 'in', angles[1]) * Math.PI) / 180
    var cx = (source.left + source.right) / 2,
      cy = source.baseline
    function border(a) {
      var ux = Math.cos(a),
        uy = Math.sin(a)
      var d = Math.min(
        (source.right - source.left) / 2 / Math.max(Math.abs(ux), 1e-8),
        (uy > 0 ? source.top - cy : cy - source.bottom) /
          Math.max(Math.abs(uy), 1e-8),
      )
      return {
        x: cx + ux * (d + ARROW_INSET_UNITS),
        y: cy + uy * (d + ARROW_INSET_UNITS),
      }
    }
    var a = border(out),
      b = border(incoming),
      chord = Math.hypot(b.x - a.x, b.y - a.y)
    var minimum = 1422.64
    options.forEach(function (e) {
      if (e[0] === 'min distance' && e[1] !== true)
        minimum = lengthEm(String(e[1])) * UNIT
    })
    var distance = Math.max(
      minimum,
      chord * optionNumber(options, 'looseness', 8) * 0.3915,
    )
    return {
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      ux: (b.x - a.x) / (chord || 1),
      uy: (b.y - a.y) / (chord || 1),
      length: chord,
      controls: [
        a.x + Math.cos(out) * distance,
        a.y + Math.sin(out) * distance,
        b.x + Math.cos(incoming) * distance,
        b.y + Math.sin(incoming) * distance,
      ],
    }
  }

  function tipPath(tip, x, y, ux, uy) {
    function p(a, b) {
      return round(x + ux * a - uy * b) + ' ' + round(y + uy * a + ux * b)
    }
    if (tip === 'bar')
      return 'M' + p(0, 4.1 * ARROW_STROKE) + 'L' + p(0, -4.1 * ARROW_STROKE)
    if (tip === 'reversed')
      return headPath(
        x - ux * 5.2 * ARROW_STROKE,
        y - uy * 5.2 * ARROW_STROKE,
        -ux,
        -uy,
      )
    if (/^hook-/.test(tip)) {
      // PGF Hooks: half ellipse, length 3.6 rules, width 10.8 rules.
      var sign = tip === 'hook-left' ? 1 : -1,
        rx = 3.1 * ARROW_STROKE,
        ry = 2.45 * ARROW_STROKE,
        k = 0.55228475
      return (
        'M' +
        p(-rx, sign * 2 * ry) +
        'C' +
        p(-rx + k * rx, sign * 2 * ry) +
        ' ' +
        p(0, sign * (ry + k * ry)) +
        ' ' +
        p(0, sign * ry) +
        'C' +
        p(0, sign * (ry - k * ry)) +
        ' ' +
        p(-rx + k * rx, 0) +
        ' ' +
        p(-rx, 0)
      )
    }
    if (/^harpoon-/.test(tip)) {
      var sign = tip === 'harpoon-left' ? 1 : -1,
        length = 5.2 * ARROW_STROKE,
        width = (6.2 * 2.096774 - 1) * ARROW_STROKE
      return (
        'M' +
        p(-length, (sign * width) / 2) +
        'C' +
        p(-0.81731 * length, sign * 0.2 * width) +
        ' ' +
        p(-0.41019 * length, sign * 0.05833333 * width) +
        ' ' +
        p(0, 0)
      )
    }
    return (tip === 'implies' ? impliesPath : headPath)(x, y, ux, uy)
  }

  // Evaluate parallel stems on the unit normal, with arc-length trimming.
  // Refine until midpoint error is below .05 SVG units (1/20000 em), on
  // both sides together so the two stems share the same parameter samples.
  function offsetPath(ends, bend, offset, startShort, endShort) {
    var points = [],
      total = 0
    function point(t) {
      var p = curvePoint(ends, bend, t)
      p.t = t
      return p
    }
    function subdivide(a, b, depth) {
      var m = point((a.t + b.t) / 2),
        error = 0
      ;[-DOUBLE_LINE_DISTANCE / 2, 0, DOUBLE_LINE_DISTANCE / 2].forEach(
        function (o) {
          var x = m.x - m.uy * o - (a.x - a.uy * o + b.x - b.uy * o) / 2
          var y = m.y + m.ux * o - (a.y + a.ux * o + b.y + b.ux * o) / 2
          error = Math.max(error, Math.hypot(x, y))
        },
      )
      if (error > 0.05 && depth < 14) {
        subdivide(a, m, depth + 1)
        subdivide(m, b, depth + 1)
      } else points.push(b)
    }
    points.push(point(0))
    for (var part = 0; part < 16; part++)
      subdivide(point(part / 16), point((part + 1) / 16), 0)
    points.forEach(function (p, i) {
      if (i) total += Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y)
      p.distance = total
    })
    var low = Math.min(startShort, total / 2),
      high = Math.max(low, total - endShort),
      selected = []
    function at(d) {
      for (var i = 1; i < points.length; i++)
        if (points[i].distance >= d) {
          var f =
            (d - points[i - 1].distance) /
            (points[i].distance - points[i - 1].distance || 1)
          return curvePoint(
            ends,
            bend,
            points[i - 1].t + f * (points[i].t - points[i - 1].t),
          )
        }
      return points[points.length - 1]
    }
    selected.push(at(low))
    points.forEach(function (p) {
      if (p.distance > low && p.distance < high) selected.push(p)
    })
    selected.push(at(high))
    return selected
      .map(function (p, i) {
        return (
          (i ? 'L' : 'M') +
          round(p.x - p.uy * offset) +
          ' ' +
          round(p.y + p.ux * offset)
        )
      })
      .join('')
  }

  /**
   * Draw one arrow into `api`, reading its endpoints from `layout`.
   *
   * Everything here is in SVG units (1/1000 em) because that is the space the
   * grid was measured in.
   */
  function drawArrow(api, layout, spec) {
    var options = spec.options || []
    var from = spec.from
    if (!from) return null
    var source = layout.boxes[from.row + '-' + from.column]
    if (!source) return null
    var targetPos = spec.to || {
      row: from.row + spec.dy,
      column: from.column + spec.dx,
    }
    // An arrow may point out of the grid — the last cell of a row with `\ar[r]` is
    // the ordinary case, and a diagram whose arrows leave its edge is normal
    // mathematics. The target is then a cell-sized space just beyond that edge
    // rather than a cell that does not exist, because clamping it back inside
    // would draw the arrow on top of its own source.
    var target = targetBox(layout, source, targetPos)
    if (!target) return null

    var dx = targetPos.column - from.column
    var dy = targetPos.row - from.row
    var loop = options.some(function (e) {
      return /^loop(?: (above|below|left|right))?$/.test(e[0])
    })
    if (!dx && !dy && !loop) return null
    var bendAngle = 0
    options.forEach(function (e) {
      if (e[0] === 'bend left' || e[0] === 'bend right')
        bendAngle =
          ((e[1] === true ? 30 : Number(e[1])) *
            (e[0] === 'bend left' ? 1 : -1) *
            Math.PI) /
          180
    })
    var ends = loop
      ? loopEnds(source, options)
      : bendAngle || hasOption(options, 'out') || hasOption(options, 'in')
        ? curvedEnds(source, target, options, bendAngle)
        : arrowEnds(source, target, dx, dy)
    if (!isFinite(ends.length) || ends.length <= 20) return null

    var shift = shiftOffset(options)
    if (shift) {
      var sx = -ends.uy * shift
      var sy = ends.ux * shift
      var controls = ends.controls
      ends = {
        x1: ends.x1 + sx,
        y1: ends.y1 + sy,
        x2: ends.x2 + sx,
        y2: ends.y2 + sy,
        ux: ends.ux,
        uy: ends.uy,
        length: ends.length,
        controls:
          controls &&
          controls.map(function (n, i) {
            return n + (i % 2 ? sy : sx)
          }),
      }
    }

    var bend = 0

    var group = api.create('g', { 'data-tikzcd-arrow': '1' })
    var style = arrowStyle(options)
    var p0 = curvePoint(ends, bend, 0),
      p1 = curvePoint(ends, bend, 1)
    var startTangent = { x: p0.ux, y: p0.uy },
      endTangent = { x: p1.ux, y: p1.uy }
    function shortening(tip) {
      return tip === 'implies'
        ? 1.03 * DOUBLE_LINE_DISTANCE + ARROW_STROKE / 2
        : /^hook-/.test(tip || '')
          ? 3.1 * ARROW_STROKE
          : 0
    }
    var startShort = shortening(style.start),
      endShort = shortening(style.end)
    var offsets = style.doubleLine
      ? [-DOUBLE_LINE_DISTANCE / 2, DOUBLE_LINE_DISTANCE / 2]
      : [0]
    offsets.forEach(function (offset) {
      var stem = Object.assign({}, ends, {
        x1: ends.x1 + startTangent.x * startShort - startTangent.y * offset,
        y1: ends.y1 + startTangent.y * startShort + startTangent.x * offset,
        x2: ends.x2 - endTangent.x * endShort - endTangent.y * offset,
        y2: ends.y2 - endTangent.y * endShort + endTangent.x * offset,
      })
      var path = ends.controls
        ? style.doubleLine || startShort || endShort
          ? offsetPath(ends, bend, offset, startShort, endShort)
          : 'M' +
            round(ends.x1) +
            ' ' +
            round(ends.y1) +
            'C' +
            ends.controls.map(round).join(' ') +
            ' ' +
            round(ends.x2) +
            ' ' +
            round(ends.y2)
        : shaftPath(stem, bend)
      var shaft = { d: path, fill: 'none', 'data-tikzcd-shaft': '1' }
      if (style.dashed)
        shaft['stroke-dasharray'] =
          String(7 * ARROW_STROKE) + ' ' + String(4 * ARROW_STROKE)
      api.append(group, api.create('path', shaft))
    })
    function drawTip(tip, x, y, ux, uy, endpoint) {
      if (!tip) return
      var count = tip === 'double' ? 2 : 1
      for (var t = 0; t < count; t++) {
        var back = t * 3.6 * ARROW_STROKE
        api.append(
          group,
          api.create('path', {
            d: tipPath(tip, x - ux * back, y - uy * back, ux, uy),
            fill: 'none',
            'stroke-linecap': 'round',
            'data-tikzcd-head': '1',
            'data-tikzcd-endpoint': endpoint,
          }),
        )
      }
    }
    drawTip(
      style.start,
      ends.x1,
      ends.y1,
      -startTangent.x,
      -startTangent.y,
      'start',
    )
    drawTip(style.end, ends.x2, ends.y2, endTangent.x, endTangent.y, 'end')

    var labels = spec.labels || []
    var placements = spec.placements || []
    for (var i = 0; i < labels.length; i++) {
      var label = api.labels[spec.labelKey + ':' + i]
      if (label)
        api.append(
          group,
          labelElement(api, ends, label, placements[i] || '', bend, options),
        )
    }
    return group
  }

  /** Position a MathJax-typeset label, upright by default as in TikZ-CD. */
  function labelElement(api, ends, label, placement, bend, options) {
    var settings =
      placement +
      ' ' +
      options
        .filter(function (e) {
          return /^(pos|near start|near end|very near start|very near end|at start|at end|midway|sloped|allow upside down|description|swap)$/.test(
            e[0],
          )
        })
        .map(function (e) {
          return e[0] + (e[1] === true ? '' : '=' + e[1])
        })
        .join(' ')
    var flipped = placement.indexOf("'") >= 0 && placement.indexOf("''") < 0
    if (/\bswap\b/.test(settings)) flipped = !flipped
    var t = 0.5,
      match = /\bpos\s*=\s*([\d.]+)/.exec(settings)
    if (/\bat start\b/.test(settings)) t = 0
    if (/\bat end\b/.test(settings)) t = 1
    if (/\bnear start\b/.test(settings))
      t = /\bvery near start\b/.test(settings) ? 0.125 : 0.25
    if (/\bnear end\b/.test(settings))
      t = /\bvery near end\b/.test(settings) ? 0.875 : 0.75
    if (match) t = clamp(Number(match[1]), 0, 1)
    var point = curvePoint(ends, bend, t),
      nx = -point.uy,
      ny = point.ux
    if (/\bbelow\b/.test(settings)) {
      if (ny > 0) flipped = true
      else flipped = false
    }
    if (/\babove\b/.test(settings)) {
      if (ny < 0) flipped = true
      else flipped = false
    }
    if (/\bleft\b/.test(placement)) {
      if (nx > 0) flipped = true
      else flipped = false
    }
    if (/\bright\b/.test(placement)) {
      if (nx < 0) flipped = true
      else flipped = false
    }
    var box = labelMetrics.get(label)
    var w = box.width,
      h = box.ascent,
      d = box.depth
    var angle = /\bsloped\b/.test(settings) ? Math.atan2(point.uy, point.ux) : 0
    if (
      !/allow upside down/.test(settings) &&
      (angle > Math.PI / 2 || angle < -Math.PI / 2)
    )
      angle += angle > 0 ? -Math.PI : Math.PI
    var bw = Math.abs(Math.cos(angle)) * w + Math.abs(Math.sin(angle)) * (h + d)
    var bh = Math.abs(Math.sin(angle)) * w + Math.abs(Math.cos(angle)) * (h + d)
    var side = flipped ? -1 : 1
    var description = /\bdescription\b/.test(settings)
    var clearance = description
      ? 0
      : (Math.abs(nx) * bw + Math.abs(ny) * bh) / 2 + 0.22 * UNIT
    var cx = point.x + nx * side * clearance,
      cy = point.y + ny * side * clearance
    function intersects(b) {
      return (
        cx + bw / 2 > b.left &&
        cx - bw / 2 < b.right &&
        cy + bh / 2 > b.bottom &&
        cy - bh / 2 < b.top
      )
    }
    var obstacles = api.obstacles.concat(api.labelBoxes)
    if (!description)
      for (var attempt = 0; attempt <= obstacles.length; attempt++) {
        var hits = obstacles.filter(intersects)
        if (!hits.length) break
        var advance = 0,
          vx = nx * side,
          vy = ny * side
        hits.forEach(function (b) {
          var ax =
            Math.abs(vx) < 1e-8
              ? Infinity
              : ((vx > 0 ? b.right + bw / 2 : b.left - bw / 2) - cx) / vx
          var ay =
            Math.abs(vy) < 1e-8
              ? Infinity
              : ((vy > 0 ? b.top + bh / 2 : b.bottom - bh / 2) - cy) / vy
          advance = Math.max(advance, Math.min(ax, ay) + 0.1 * UNIT)
        })
        cx += vx * advance
        cy += vy * advance
      }
    ;['xshift', 'yshift'].forEach(function (key) {
      var shifted = new RegExp(
        '\\b' + key + '\\s*=\\s*([+-]?[\\d.]+\\s*(?:em|ex|pt|pc|cm|mm|in|bp))',
      ).exec(placement)
      if (shifted) {
        var amount = lengthEm(shifted[1]) * UNIT
        if (key === 'xshift') cx += amount
        else cy += amount
      }
    })
    var bounds = {
      left: cx - bw / 2 - 0.02 * UNIT,
      right: cx + bw / 2 + 0.02 * UNIT,
      bottom: cy - bh / 2 - 0.02 * UNIT,
      top: cy + bh / 2 + 0.02 * UNIT,
    }
    api.labelBoxes.push(bounds)
    api.bound(bounds.left, bounds.bottom, bounds.right, bounds.top)
    if (description) api.cutouts.push(bounds)
    var transform = angle
      ? 'translate(' +
        round(cx) +
        ',' +
        round(cy) +
        ') rotate(' +
        round((angle * 180) / Math.PI) +
        ') translate(' +
        round(-w / 2) +
        ',' +
        round(-(h - d) / 2) +
        ')'
      : 'translate(' + round(cx - w / 2) + ',' + round(cy - (h - d) / 2) + ')'
    var group = api.create('g', {
      transform: transform,
      'data-tikzcd-label': '1',
      'stroke-width': '0',
    })
    api.detach(label)
    api.append(group, label)
    return group
  }

  /* ---------------------------------------------------------------- *
   * The SVG output
   * ---------------------------------------------------------------- */

  /** Diagrams drawn so far, so a re-render does not draw them twice. */
  var drawnGrids = typeof WeakSet === 'function' ? new WeakSet() : null
  var maskSequence = 0

  /**
   * Install the arrow drawing on the SVG output jax.
   *
   * There is no extension point for a second output jax, and the SVG jax's
   * filters live on its *instance*, not on its class — while this file is loaded
   * before that instance exists. The instance is built by
   * `startup.getOutputJax()`, so that call is wrapped: the jax is created exactly
   * as it would have been, and the filter is added to it before it is handed
   * back. Nothing else about the output path is touched.
   */
  /**
   * Register the SVG filter on the output jax.
   *
   * The filter lives on the jax *instance*, which does not exist while this file is
   * being loaded, so `startup.getOutputJax` is wrapped: the jax is created exactly
   * as it would have been and the filter is attached before it is handed back.
   * Nothing else about the output path is touched.
   */
  function installOutputFilter(internalsRef) {
    var startup = internalsRef.components.startup.Startup
    if (!startup || startup.__tikzcdOutput || !startup.getOutputJax) return
    startup.__tikzcdOutput = true

    var original = startup.getOutputJax
    startup.getOutputJax = function () {
      var jax = original.apply(this, arguments)
      try {
        if (
          jax &&
          jax.constructor &&
          jax.constructor.NAME === 'SVG' &&
          jax.typeset
        ) {
          var originalProcessMath = jax.processMath
          jax.processMath = function (wrapper, parent) {
            function prepare(node) {
              node.childNodes.forEach(prepare)
              if (
                !node.node.attributes ||
                !node.node.attributes.get('data-tikzcd-grid')
              )
                return
              var specs =
                decodeSpecs(node.node.attributes.get('data-tikzcd-specs')) || []
              var sizes = {}
              function findLabels(child) {
                if (
                  child !== node &&
                  child.node.attributes &&
                  child.node.attributes.get('data-tikzcd-grid')
                )
                  return
                var key =
                  child.node.attributes &&
                  child.node.attributes.get('data-tikzcd-label-content')
                if (key !== undefined && key !== null) {
                  var b = child.getBBox()
                  sizes[key] = { w: b.w * b.rscale, h: (b.h + b.d) * b.rscale }
                }
                child.childNodes.forEach(findLabels)
              }
              findLabels(node)
              var data = node.getTableData()
              var origins = JSON.parse(
                node.node.attributes.get('data-tikzcd-origin-spacing') || '{}',
              )
              if (origins.column)
                node.cSpace = node.cSpace.map(function (space, i) {
                  return space - (data.W[i] + data.W[i + 1]) / 2
                })
              if (origins.row)
                node.rSpace = node.rSpace.map(function (space, i) {
                  return space - data.D[i] - data.H[i + 1]
                })
              var verticalLabels = []
              specs.forEach(function (spec) {
                var target = spec.to || {
                  row: spec.from.row + spec.dy,
                  column: spec.from.column + spec.dx,
                }
                spec.labels.forEach(function (_, i) {
                  var size = sizes[spec.labelKey + ':' + i]
                  if (!size) return
                  var place = spec.placements[i] || ''
                  var below =
                    (place.indexOf("'") >= 0 && place.indexOf("''") < 0) ||
                    /below/.test(place)
                  if (/above/.test(place)) below = false
                  if (
                    target.column === spec.from.column &&
                    target.row !== spec.from.row
                  ) {
                    verticalLabels.push({
                      column: spec.from.column - 1,
                      left: below !== target.row < spec.from.row,
                      size: size,
                    })
                    return
                  }
                  if (target.row !== spec.from.row) return
                  if (target.column < spec.from.column) below = !below
                  var row = spec.from.row - 1
                  if (row < 0 || row >= data.H.length) return
                  if (below)
                    data.D[row] = Math.max(data.D[row], size.h + 0.22 - 0.25)
                  else data.H[row] = Math.max(data.H[row], size.h + 0.22 + 0.25)
                  if (Math.abs(target.column - spec.from.column) === 1) {
                    var column = Math.min(target.column, spec.from.column) - 1
                    if (column >= 0 && column < node.cSpace.length) {
                      node.cSpace[column] = Math.max(
                        node.cSpace[column],
                        size.w + 0.44,
                      )
                    }
                  }
                })
              })
              node.invalidateBBox()
              // Vertical labels can extend beyond the first/last column. Reserve
              // that space outside the table, so cells and arrow lengths stay put
              // and surrounding mathematics receives the correct bounding box.
              var left = 0,
                right = 0
              var tableWidth = node.getBBox().w
              verticalLabels.forEach(function (label) {
                if (label.column < 0 || label.column >= data.W.length) return
                var center = data.W[label.column] / 2
                for (var c = 0; c < label.column; c++)
                  center += data.W[c] + node.cSpace[c]
                if (label.left)
                  left = Math.max(left, label.size.w + 0.22 - center)
                else
                  right = Math.max(
                    right,
                    center + label.size.w + 0.22 - tableWidth,
                  )
              })
              var holder = node.parent
              while (
                holder &&
                !(
                  holder.node.attributes &&
                  holder.node.attributes.get('data-tikzcd-label-bounds')
                )
              )
                holder = holder.parent
              if (holder) {
                holder.node.attributes.set('width', '+' + (left + right) + 'em')
                holder.node.attributes.set('lspace', left + 'em')
                holder.invalidateBBox()
              }
            }
            prepare(wrapper)
            originalProcessMath.call(this, wrapper, parent)
            drawDiagrams(this, null, parent)
            var changed = false
            function reserve(node) {
              node.childNodes.forEach(reserve)
              if (
                !node.node.attributes ||
                !node.node.attributes.get('data-tikzcd-grid') ||
                !node.dom[0]
              )
                return
              var bounds = diagramBounds.get(node.dom[0])
              if (!bounds) return
              var box = node.getBBox(),
                holder = node.parent
              while (
                holder &&
                !(
                  holder.node.attributes &&
                  holder.node.attributes.get('data-tikzcd-label-bounds')
                )
              )
                holder = holder.parent
              if (!holder) return
              var left = Math.max(0, -bounds.left / UNIT),
                right = Math.max(0, bounds.right / UNIT - box.w)
              var top = Math.max(0, bounds.top / UNIT - box.h),
                bottom = Math.max(0, -bounds.bottom / UNIT - box.d)
              var attrs = {
                width: '+' + (left + right) + 'em',
                lspace: left + 'em',
                height: '+' + top + 'em',
                depth: '+' + bottom + 'em',
              }
              Object.keys(attrs).forEach(function (key) {
                if (holder.node.attributes.get(key) !== attrs[key]) {
                  holder.node.attributes.set(key, attrs[key])
                  changed = true
                }
              })
              holder.invalidateBBox()
            }
            reserve(wrapper)
            if (changed) {
              var adaptor = this.adaptor
              childElements(adaptor, parent)
                .filter(function (n) {
                  return adaptor.kind(n) === 'svg'
                })
                .forEach(function (n) {
                  adaptor.remove(n)
                })
              if (this.options.fontCache === 'local')
                this.fontCache.clearCache()
              originalProcessMath.call(this, wrapper, parent)
              drawDiagrams(this, null, parent)
            }
          }
          // MathJax still has its wrapper tree here. Retain its exact cell
          // metrics before typeset clears it, rather than guessing glyph widths.
          var originalTypesetSvg = jax.typesetSvg
          jax.typesetSvg = function (wrapper, svg, group) {
            originalTypesetSvg.call(this, wrapper, svg, group)
            function remember(node) {
              if (
                node.node.attributes &&
                node.node.attributes.get('data-tikzcd-label-content') !==
                  undefined &&
                node.dom &&
                node.dom[0]
              ) {
                var labelBox = node.getBBox()
                labelMetrics.set(node.dom[0], {
                  width: labelBox.w * labelBox.rscale * UNIT,
                  ascent: labelBox.h * labelBox.rscale * UNIT,
                  depth: labelBox.d * labelBox.rscale * UNIT,
                })
              }
              if (node.node.kind === 'mtd' && node.dom && node.dom[0]) {
                var box = node.getBBox()
                cellMetrics.set(node.dom[0], {
                  width: box.w * UNIT,
                  height: (box.h + box.d) * UNIT,
                  ascent: box.h * UNIT,
                  depth: box.d * UNIT,
                })
              }
              for (var i = 0; i < node.childNodes.length; i++)
                remember(node.childNodes[i])
            }
            remember(wrapper)
          }
          var originalTypeset = jax.typeset
          // `typeset` returns the `<mjx-container>` it built, which is exactly the
          // subtree to look in for diagrams. Reaching them through a post-filter
          // instead does not work: the MathML root is what a filter is handed, and
          // the wrapper map that would connect the two is cleared before filters
          // run.
          jax.typeset = function (math, document) {
            var container = originalTypeset.call(this, math, document)
            try {
              drawDiagrams(this, document, container)
            } catch (err) {
              // A failure here must not cost the reader the whole equation.
              if (typeof console !== 'undefined' && console.warn) {
                console.warn(
                  '[tikzcd] could not draw the arrows: ' +
                    (err && err.message ? err.message : err),
                )
              }
            }
            return container
          }
        }
      } catch (err) {
        void err
      }
      return jax
    }
  }

  /**
   * Draw every diagram in one typeset result.
   *
   * `container` is the `<mjx-container>` the output was written into, so the grids
   * are found by walking that.
   */
  function drawDiagrams(jax, document, container) {
    var adaptor = jax.adaptor
    if (!adaptor || !container) return
    void document
    var grids = []
    collectGrids(adaptor, container, grids)
    for (var i = 0; i < grids.length; i++) {
      if (drawnGrids) {
        if (drawnGrids.has(grids[i])) continue
        drawnGrids.add(grids[i])
      }
      drawGrid(jax, adaptor, grids[i])
    }
  }

  function collectGrids(adaptor, node, out) {
    var children = childElements(adaptor, node)
    for (var i = 0; i < children.length; i++) {
      var child = children[i]
      if (
        adaptor.kind(child) === 'g' &&
        adaptor.getAttribute(child, 'data-tikzcd-grid')
      ) {
        out.push(child)
      }
      collectGrids(adaptor, child, out)
    }
  }

  /** Draw one diagram's arrows into its grid group. */
  function drawGrid(jax, adaptor, grid) {
    var specs = decodeSpecs(adaptor.getAttribute(grid, 'data-tikzcd-specs'))
    if (!specs) return
    var layout = measureSvg(adaptor, grid)
    if (!layout) return

    var group = jax.svg('g', {
      'data-tikzcd-arrows': '1',
      fill: 'currentColor',
      stroke: 'currentColor',
      'stroke-width': String(ARROW_STROKE),
      'stroke-linecap': 'butt',
      'stroke-linejoin': 'round',
    })
    adaptor.append(grid, group)

    var labels = {}
    function collectLabels(node) {
      if (node !== grid && adaptor.getAttribute(node, 'data-tikzcd-grid'))
        return
      var key = adaptor.getAttribute(node, 'data-tikzcd-label-content')
      if (key !== undefined && key !== null && labelMetrics.has(node))
        labels[key] = node
      childElements(adaptor, node).forEach(collectLabels)
    }
    collectLabels(grid)
    var bounds = {
      left: Infinity,
      right: -Infinity,
      top: -Infinity,
      bottom: Infinity,
    }
    function bound(left, bottom, right, top) {
      bounds.left = Math.min(bounds.left, left)
      bounds.right = Math.max(bounds.right, right)
      bounds.bottom = Math.min(bounds.bottom, bottom)
      bounds.top = Math.max(bounds.top, top)
    }
    var api = {
      bound: bound,
      obstacles: Object.keys(layout.boxes).map(function (key) {
        return layout.boxes[key]
      }),
      labelBoxes: [],
      cutouts: [],
      labels: labels,
      detach: function (node) {
        adaptor.remove(node)
      },
      create: function (kind, def) {
        if (kind === 'path' && def.d) {
          var numbers = def.d
            .match(/[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/gi)
            .map(Number)
          for (var n = 0; n < numbers.length - 1; n += 2)
            bound(
              numbers[n] - ARROW_STROKE,
              numbers[n + 1] - ARROW_STROKE,
              numbers[n] + ARROW_STROKE,
              numbers[n + 1] + ARROW_STROKE,
            )
        }
        return jax.svg(kind, def)
      },
      text: function (value) {
        return jax.text(value)
      },
      append: function (parent, node) {
        return appendNode(adaptor, parent, node)
      },
    }

    for (var i = 0; i < specs.length; i++) {
      var drawn = drawArrow(api, layout, specs[i])
      if (drawn) appendNode(adaptor, group, drawn)
    }
    if (api.cutouts.length) {
      var id = 'tikzcd-label-mask-' + ++maskSequence
      var mask = jax.svg('mask', {
        id: id,
        maskUnits: 'userSpaceOnUse',
        x: bounds.left - UNIT,
        y: bounds.bottom - UNIT,
        width: bounds.right - bounds.left + 2 * UNIT,
        height: bounds.top - bounds.bottom + 2 * UNIT,
      })
      adaptor.append(
        mask,
        jax.svg('rect', {
          x: bounds.left - UNIT,
          y: bounds.bottom - UNIT,
          width: bounds.right - bounds.left + 2 * UNIT,
          height: bounds.top - bounds.bottom + 2 * UNIT,
          fill: 'white',
          stroke: 'none',
        }),
      )
      api.cutouts.forEach(function (b) {
        adaptor.append(
          mask,
          jax.svg('rect', {
            x: b.left - 80,
            y: b.bottom - 80,
            width: b.right - b.left + 160,
            height: b.top - b.bottom + 160,
            fill: 'black',
            stroke: 'none',
          }),
        )
      })
      childElements(adaptor, group).forEach(function (arrow) {
        childElements(adaptor, arrow).forEach(function (path) {
          if (adaptor.kind(path) === 'path')
            adaptor.setAttribute(path, 'mask', 'url(#' + id + ')')
        })
      })
      adaptor.append(group, mask)
    }
    if (isFinite(bounds.left)) diagramBounds.set(grid, bounds)
  }

  /**
   * Append a node built from markup this file wrote.
   *
   * The DOM adaptor is LiteDOM under Node and the browser's DOM in the renderer,
   * and neither accepts an element built by the other. Markup therefore goes in as
   * a text node and is parsed into elements at the very end, by the one step that
   * is allowed to differ between the two: the SVG's own serialisation. Until then
   * the markup is held on the group, which is what `data-tikzcd-markup` is for.
   */
  function appendNode(adaptor, parent, node) {
    if (node && node.__tikzcdMarkup) {
      var held = adaptor.getAttribute(parent, 'data-tikzcd-markup') || ''
      adaptor.setAttribute(
        parent,
        'data-tikzcd-markup',
        held + node.__tikzcdMarkup,
      )
      return parent
    }
    return adaptor.append(parent, node)
  }

  /* ---------------------------------------------------------------- *
   * Registration
   * ---------------------------------------------------------------- */

  function register() {
    var internalsRef = internals()
    installOutputFilter(internalsRef)

    var Configuration = internalsRef.input.tex.Configuration.Configuration
    var EnvironmentMap = internalsRef.input.tex.TokenMap.EnvironmentMap
    var NodeFactory = internalsRef.input.tex.NodeFactory.NodeFactory
    var combineWithMathJax = internalsRef.components.global.combineWithMathJax

    // `ParseMethods.environment` is the shared wrapper every environment in the
    // distribution goes through: it makes the opening `begin` item, hands it to
    // the environment's own method, and pushes what that returns. Passing a method
    // here directly — or the map's name, which reads as if it belonged — makes the
    // "method" receive the map's JSON value instead of an item, and fails several
    // frames later as `isKind is not a function` or as a diagram that silently
    // disappears.
    var ParseMethods = internalsRef.input.tex.ParseMethods.default
    new EnvironmentMap(CONFIG, ParseMethods.environment, {
      tikzcd: TikzcdEnvironment,
      'tikzcd*': TikzcdEnvironment,
    })

    var configuration = Configuration.create(CONFIG, {
      handler: { environment: [CONFIG] },
      // TeX-level node *creators*, keyed by the node kind the parser creates.
      // These are not MML node classes, which live in a different table.
      nodes: {
        tikzcd: function (factory, kind, children, def) {
          return NodeFactory.createNode(factory, kind, children, def)
        },
      },
      priority: 5,
    })

    if (typeof MathJax !== 'undefined' && MathJax.loader) {
      MathJax.loader.checkVersion(
        '[tex]/tikzcd',
        MATHJAX_VERSION,
        'tex-extension',
      )
    }
    combineWithMathJax({
      _: { input: { tex: { tikzcd: { TikzcdConfiguration: configuration } } } },
    })
    grown.registered = true
    stage('registered')
  }

  stage('registering')
  register()
})()
