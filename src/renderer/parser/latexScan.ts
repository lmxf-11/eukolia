/**
 * Eukolia — the linear source scan.
 *
 * One pass over the characters of a `.tex` file, collecting what the analysis needs:
 * sectioning, labels, citations, includes, environments and macro definitions. No
 * AST, no parser, no per-macro grammar.
 *
 * **Why it exists.** The AST analysis costs ~0.19 ms per line, measured on a real
 * chapter of the Stacks project: 400 ms at 2 000 lines, 13 s at 47 886 lines (1.77
 * MB). It is linear, so it is not a bug — it is the shape of the work. A whole
 * document is parsed with `latex-utensils`' PEG grammar, its macro arguments are
 * resolved, and then the tree is walked three times. VS Code does not do that for a
 * file it opens: its tokenizer is line-based and viewport-scoped, so a 47 886-line
 * file is tokenized only where the user is looking, and nothing in its core parses
 * the whole buffer. This is Eukolia's equivalent of that rule — a pass whose cost is
 * a function of the *document*, done in ~10 ms for a document of any size, so that
 * opening a large file is not a 13-second freeze.
 *
 * **What it is not.** It is not the parser, and it does not try to be: catcode
 * tricks, `\csname`, conditional compilation and macro-expanded structure are all
 * invisible to it, exactly as they are to any regex-based tool. It reads the source
 * the way a careful editor would: comments are skipped, `\{` is not a brace,
 * verbatim bodies are not LaTeX, and arguments are read by brace balancing. Above
 * the threshold the AST is not built at all, and the difference is named in the
 * large-file notice rather than hidden.
 */

import type {
  CitationInfo,
  EnvironmentInfo,
  IncludedFileInfo,
  LabelInfo,
  MacroDefinitionInfo,
  SectioningInfo
} from '../document/analysisTypes'
import { getUnicodeMathSymbol } from '../vendor/latex-workshop/unimath'
import {
  advanceTo,
  isEof,
  makeCursor,
  normalizeDefinitionText,
  peek,
  readArgumentsAt,
  readDelimited,
  skipBlanks,
  take,
  type Cursor
} from './sourceText'

/**
 * The number of lines above which scanning is used instead of parsing.
 *
 * 2 000 is the point where the AST stops being affordable for an interactive path:
 * measured at ~0.19 ms per line, that is ~380 ms of blocked renderer thread, and it
 * grows from there (4 000 lines ≈ 800 ms, 16 000 ≈ 3 s). It is also the app's
 * existing "no widget pass" rung in `visual/largeDocument.ts`, so the two thresholds
 * describe the same kind of document.
 */
export const SOURCE_SCAN_LINES = 2_000

export interface ScanOptions {
  /** Sectioning commands, mapped to their outline level. */
  sections: ReadonlyMap<string, number>
  /** Commands whose braced argument names a file the document pulls in. */
  inputCommands: ReadonlySet<string>
  resourceCommands: ReadonlySet<string>
  /** Citation commands, matched against the control sequence's name. */
  citeCommands: RegExp
  /** `\newcommand`-family commands: the first argument names the macro. */
  newCommandCommands: ReadonlySet<string>
  /** `\providecommand`-family commands, where the name may be the first argument. */
  provideCommandCommands: ReadonlySet<string>
  /** `\DeclarePairedDelimiter*`, whose name comes first and unbraced. */
  mathOperatorCommands: ReadonlySet<string>
  /** `\newenvironment`-family commands, whose first argument is an environment name. */
  environmentCommands: ReadonlySet<string>
  /** `\def` and friends, whose statement is read to its balanced end. */
  primitiveCommands: ReadonlySet<string>
  /** `\LetLtxMacro`, rewritten to the `\def` it is equivalent to. */
  aliasCommands: ReadonlySet<string>
  /**
   * Environments the parser represents as verbatim nodes: their bodies are not
   * LaTeX, and — because the AST has no `environment` node for them — they are not
   * reported as environments either. `latex.verbatimEnvs`, from the settings, is the
   * same list the parser is built with, so both paths see the same documents.
   */
  verbatimEnvironments: ReadonlySet<string>
}

export interface ScanResult {
  labels: LabelInfo[]
  citations: CitationInfo[]
  macroDefinitions: MacroDefinitionInfo[]
  /** `EnvironmentInfo` plus the plain `line` `DocumentModel`'s contract asks for. */
  environments: Array<EnvironmentInfo & { line: number }>
  includedFiles: IncludedFileInfo[]
  sectioning: SectioningInfo[]
}

/**
 * The environments the parser treats as verbatim, when the settings do not say.
 *
 * `latex.verbatimEnvs` is the parser's own setting and the default below is its
 * default; it is read from the settings at analysis time so a user who adds an
 * environment to it gets the same answer from both paths.
 */
export const DEFAULT_VERBATIM_ENVIRONMENTS: ReadonlySet<string> = new Set(['verbatim', 'lstlisting', 'minted'])

/** Formatting macros whose braced argument is what a title should show. */
const FORMATTING_MACROS = new Set([
  'textbf',
  'textit',
  'text',
  'emph',
  'textrm',
  'textsf',
  'texttt',
  'textsl',
  'textsc',
  'textup',
  'textnormal'
])

/** A control sequence: `\name`, or a single-symbol `\%`. `starred` eats a `*`. */
function readCommand(cursor: Cursor): { name: string; symbol: string; starred: boolean; start: number } | null {
  if (peek(cursor) !== '\\') return null
  const start = cursor.index
  take(cursor)
  if (isEof(cursor)) return { name: '', symbol: '', starred: false, start }
  let name = ''
  if (/[a-zA-Z@]/.test(peek(cursor))) {
    while (!isEof(cursor) && /[a-zA-Z@]/.test(peek(cursor))) name += take(cursor)
  } else {
    // A control symbol: `\\`, `\%`, `\{`, `\,` … `name` stays empty and `symbol`
    // carries the character, which is what an outline shows for `\%`.
    const symbol = take(cursor)
    return { name: '', symbol, starred: false, start }
  }
  let starred = false
  if (peek(cursor) === '*') {
    take(cursor)
    starred = true
  }
  return { name, symbol: '', starred, start }
}

/**
 * The title a sectioning command shows, from the raw argument text.
 *
 * A text-level reading of `sanitizeLabel`: math delimiters are dropped but their
 * contents kept, `\alpha` and friends become the Unicode symbol they stand for, a
 * formatting macro contributes its argument, `\texorpdfstring` contributes its
 * second (the one meant for text), and runs of whitespace collapse.
 */
export function plainTitle(raw: string): string {
  let out = ''
  const cursor = makeCursor(raw)
  while (!isEof(cursor)) {
    const char = peek(cursor)
    if (char === '%') {
      while (!isEof(cursor) && peek(cursor) !== '\n') take(cursor)
      out += ' '
      continue
    }
    if (char === '$') {
      // Math shifts contribute their contents; the delimiters do not.
      take(cursor)
      if (peek(cursor) === '$') take(cursor)
      continue
    }
    if (char === '\\') {
      const command = readCommand(cursor)
      if (!command) continue
      if (command.name === '') {
        // A control symbol contributes its own text, which is what the AST path
        // shows for `\%` and `\{`: `macroContentToLabel` renders the node as the
        // character it is.
        out += command.symbol === '\\' ? ' ' : `\\${command.symbol}`
        continue
      }
      if (command.name === 'texorpdfstring') {
        skipBlanks(cursor)
        readDelimited(cursor, '{', '}')
        skipBlanks(cursor)
        const text = readDelimited(cursor, '{', '}')
        if (text) out += plainTitle(text.text)
        continue
      }
      skipBlanks(cursor)
      const argument = peek(cursor) === '{' ? readDelimited(cursor, '{', '}') : null
      if (FORMATTING_MACROS.has(command.name) && argument) {
        out += plainTitle(argument.text)
        continue
      }
      const symbol = getUnicodeMathSymbol(command.name)
      if (symbol !== undefined && !argument) {
        out += symbol
        continue
      }
      out += `\\${command.name}`
      if (argument) out += argument.text
      continue
    }
    out += take(cursor)
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** The macro name a `\newcommand{\x}`-style target denotes, without its backslash. */
function macroNameFromArgument(raw: string): string | null {
  const trimmed = raw.trim()
  const match = /^\\([a-zA-Z@]+)\s*$/.exec(trimmed)
  if (match) return match[1]
  return null
}

/** `#1`-style parameter count of a TeX parameter text. */
function parameterCount(text: string): number {
  let max = 0
  for (const match of text.matchAll(/#([1-9])/g)) {
    max = Math.max(max, Number(match[1]))
  }
  return max
}

/**
 * Where a `\def`-style statement ends: the balanced close of its body, or the end of
 * the line when there is no brace. The same rule `newcommand.ts` uses, so the slice
 * this produces is the slice the AST path produces.
 */
function statementEnd(text: string, start: number, from: number): number {
  const braceStart = text.indexOf('{', from)
  const newline = text.indexOf('\n', from)
  if (braceStart === -1 || (newline !== -1 && newline < braceStart)) {
    return newline === -1 ? text.length : newline
  }
  let depth = 0
  for (let index = braceStart; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return newline === -1 ? text.length : newline
}

/** Skips a verbatim environment's body, leaving the cursor on its `\end`. */
function skipVerbatimBody(cursor: Cursor, name: string): void {
  const end = cursor.text.indexOf(`\\end{${name}}`, cursor.index)
  advanceTo(cursor, end === -1 ? cursor.text.length : end)
}

/**
 * Scans one document.
 *
 * One pass, one cursor: the cost is proportional to the characters and nothing is
 * allocated per node, which is what makes it usable on a file of any size.
 */
export function scanLatexSource(text: string, options: ScanOptions): ScanResult {
  const labels: LabelInfo[] = []
  const citations: CitationInfo[] = []
  const macroDefinitions: MacroDefinitionInfo[] = []
  const environments: Array<EnvironmentInfo & { line: number }> = []
  const includedFiles: IncludedFileInfo[] = []
  const sectioning: SectioningInfo[] = []

  const cursor = makeCursor(text)
  /*
   * Environments are reported when they *close*, not when they open.
   *
   * The AST has an `environment` node only for a complete `\begin`…`\end` pair, so a
   * `\begin{theorem}` with no `\end` yet — which is what a document being typed looks
   * like — contributes nothing there. Holding the pending opens on a stack until their
   * match arrives is what keeps the two answers the same.
   */
  const pending: Array<{ name: string; beginOffset: number; beginLine: number; nested: boolean }> = []
  /** The open verbatim environment whose body is being skipped, if any. */
  let skipping: string | null = null

  const enterEnvironment = (name: string, beginOffset: number, beginLine: number): void => {
    pending.push({ name, beginOffset, beginLine, nested: pending.length > 0 })
  }

  const leaveEnvironment = (name: string, endOffset: number, endLine: number): void => {
    let at = -1
    for (let index = pending.length - 1; index >= 0; index--) {
      if (pending[index].name === name) {
        at = index
        break
      }
    }
    if (at === -1) return
    const begun = pending[at]
    // Anything opened inside and never closed is dropped with it, exactly as the
    // parser drops it: there is no complete pair to report.
    pending.length = at
    environments.push({
      name: begun.name,
      beginOffset: begun.beginOffset,
      beginLine: begun.beginLine,
      endOffset,
      endLine,
      nested: begun.nested,
      line: begun.beginLine
    })
  }

  while (!isEof(cursor)) {
    const char = peek(cursor)

    if (char === '%') {
      while (!isEof(cursor) && peek(cursor) !== '\n') take(cursor)
      continue
    }
    if (char !== '\\') {
      take(cursor)
      continue
    }

    const command = readCommand(cursor)
    if (!command || command.name === '') {
      // A control symbol (`\\`, `\%`, `\{` …): nothing to collect, and the character
      // has already been consumed so an escaped `%` cannot start a comment.
      continue
    }
    const name = command.name
    const line = cursor.line
    const offset = command.start

    // ------------------------------------------------------------- environments
    if (name === 'begin' || name === 'end') {
      skipBlanks(cursor)
      const argument = readDelimited(cursor, '{', '}')
      const environment = argument?.text.trim() ?? ''
      if (environment) {
        const verbatim = options.verbatimEnvironments.has(environment)
        if (name === 'begin') {
          // A verbatim environment is not reported — the AST has a `verbatim` node
          // for it, not an `environment` node — but its body is still skipped.
          if (!verbatim) enterEnvironment(environment, offset, line)
          else skipping = environment
        } else {
          if (skipping === environment) skipping = null
          // The AST's environment node ends *after* `\end{name}`, so the end offset is
          // the far side of the closing brace rather than the command that opened it.
          else leaveEnvironment(environment, argument?.end ?? cursor.index, cursor.line)
        }
      }
      if (skipping && name === 'begin' && environment === skipping) skipVerbatimBody(cursor, skipping)
      continue
    }

    // ----------------------------------------------------------- sectioning
    const level = options.sections.get(name)
    if (level !== undefined) {
      skipBlanks(cursor)
      /*
       * The reference's `s o m` shape, and its preference: when a section carries a
       * short title (`\section[Short]{Long}`), the outline shows the *short* one —
       * that is what `collectSectioning` does with `args[1] ?? args[2]`, and the two
       * paths have to agree on the title a user sees.
       */
      const short = peek(cursor) === '[' ? readDelimited(cursor, '[', ']') : null
      skipBlanks(cursor)
      const title = peek(cursor) === '{' ? readDelimited(cursor, '{', '}') : null
      sectioning.push({
        level,
        title: plainTitle(short?.text ?? title?.text ?? ''),
        offset,
        line,
        command: name,
        starred: command.starred
      })
      continue
    }

    // --------------------------------------------------------------- labels
    if (name === 'label' || name === 'linelabel') {
      skipBlanks(cursor)
      const argument = peek(cursor) === '{' ? readDelimited(cursor, '{', '}') : null
      const label = argument?.text.trim() ?? ''
      if (label) {
        labels.push({
          name: label,
          offset,
          line,
          // The environment the label sits in, as the AST path reports it: the
          // innermost one that has been *opened*, whether or not it has closed yet —
          // the parser knows it is inside the environment as soon as it reads the
          // `\begin`, which is why this reads the pending stack rather than the
          // reported list.
          environment: pending[pending.length - 1]?.name
        })
      }
      continue
    }

    // ------------------------------------------------------------ citations
    if (options.citeCommands.test(name)) {
      skipBlanks(cursor)
      while (peek(cursor) === '[') {
        readDelimited(cursor, '[', ']')
        skipBlanks(cursor)
      }
      const argument = peek(cursor) === '{' ? readDelimited(cursor, '{', '}') : null
      const keys = (argument?.text ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter((key) => key.length > 0)
      if (keys.length > 0) citations.push({ keys, offset, line, command: name })
      continue
    }

    // ------------------------------------------------------------- includes
    if (options.inputCommands.has(name) || options.resourceCommands.has(name)) {
      skipBlanks(cursor)
      while (peek(cursor) === '[') {
        readDelimited(cursor, '[', ']')
        skipBlanks(cursor)
      }
      const argument = peek(cursor) === '{' ? readDelimited(cursor, '{', '}') : null
      const path = argument?.text.trim() ?? ''
      if (path) includedFiles.push({ path, offset, line, command: name })
      continue
    }

    // ------------------------------------------------------ macro definitions
    if (options.newCommandCommands.has(name)) {
      skipBlanks(cursor)
      const first = peek(cursor) === '{' ? readDelimited(cursor, '{', '}') : null
      if (!first) continue
      const target = macroNameFromArgument(first.text)
      let args = 0
      skipBlanks(cursor)
      if (peek(cursor) === '[') {
        const count = readDelimited(cursor, '[', ']')
        args = Number((count?.text ?? '').trim()) || 0
      }
      skipBlanks(cursor)
      if (peek(cursor) === '[') readDelimited(cursor, '[', ']')
      skipBlanks(cursor)
      const body = peek(cursor) === '{' ? readDelimited(cursor, '{', '}') : null
      const end = body?.end ?? first.end
      if (target) {
        macroDefinitions.push({
          name: target,
          args,
          offset,
          line,
          definition: normalizeDefinitionText(text.slice(offset, end)),
          primitive: false
        })
      }
      continue
    }

    if (options.provideCommandCommands.has(name) || options.mathOperatorCommands.has(name)) {
      skipBlanks(cursor)
      // The name may be bare (`\DeclarePairedDelimiterX\braketzw[2]{…}`) or braced.
      let target: string | null = null
      if (peek(cursor) === '\\') {
        const bare = readCommand(cursor)
        target = bare && bare.name ? bare.name : null
      } else if (peek(cursor) === '{') {
        const braced = readDelimited(cursor, '{', '}')
        target = macroNameFromArgument(braced?.text ?? '')
      }
      let args = 0
      skipBlanks(cursor)
      if (peek(cursor) === '[') {
        const count = readDelimited(cursor, '[', ']')
        args = Number((count?.text ?? '').trim()) || 0
      }
      skipBlanks(cursor)
      let end = cursor.index
      while (peek(cursor) === '{') {
        const body = readDelimited(cursor, '{', '}')
        end = body?.end ?? end
        skipBlanks(cursor)
      }
      if (target) {
        macroDefinitions.push({
          name: target,
          args,
          offset,
          line,
          // `\providecommand` and `\DeclareRobustCommand` are rewritten to
          // `\newcommand`, exactly as the AST path rewrites them.
          definition: normalizeDefinitionText(text.slice(offset, end)),
          primitive: false
        })
      }
      continue
    }

    if (options.environmentCommands.has(name)) {
      skipBlanks(cursor)
      const first = peek(cursor) === '{' ? readDelimited(cursor, '{', '}') : null
      const target = first?.text.trim() ?? ''
      let args = 0
      skipBlanks(cursor)
      if (peek(cursor) === '[') {
        const count = readDelimited(cursor, '[', ']')
        args = Number((count?.text ?? '').trim()) || 0
      }
      /*
       * The begin and end bodies are consumed here rather than left to the main loop.
       *
       * They are a *definition*: `\newenvironment{claim}{\begin{quote}}{\end{quote}}`
       * names `quote` in two separate arguments, and a scan that walked into them
       * would pair them and report an environment the document never opens. The
       * parser does not, because its `environment` node needs both halves in one
       * group. `readArgumentsAt` is the same reader `newcommand.ts` uses for the
       * DefinitionText of a definition whose arguments the parser did not attach.
       */
      const rest = readArgumentsAt(text, cursor.index)
      const end = Math.max(rest.end, first?.end ?? cursor.index)
      advanceTo(cursor, rest.end)
      if (target) {
        macroDefinitions.push({
          name: target,
          args,
          offset,
          line,
          definition: normalizeDefinitionText(text.slice(offset, end)),
          primitive: false
        })
      }
      continue
    }

    if (options.aliasCommands.has(name)) {
      skipBlanks(cursor)
      const readName = (): string | null => {
        if (peek(cursor) === '\\') {
          const bare = readCommand(cursor)
          return bare && bare.name ? bare.name : null
        }
        const braced = readDelimited(cursor, '{', '}')
        return macroNameFromArgument(braced?.text ?? '')
      }
      const target = readName()
      skipBlanks(cursor)
      const original = readName()
      if (target && original) {
        macroDefinitions.push({
          name: target,
          args: 0,
          offset,
          line,
          definition: `\\def\\${target}{\\${original}}`,
          primitive: true
        })
      }
      continue
    }

    if (options.primitiveCommands.has(name)) {
      skipBlanks(cursor)
      if (peek(cursor) !== '\\') continue
      const target = readCommand(cursor)
      if (!target || !target.name) continue
      const end = statementEnd(text, offset, target.start)
      const brace = text.indexOf('{', target.start)
      const parameterText =
        name === 'let' || brace === -1 || brace > end ? '' : text.slice(target.start + target.name.length + 1, brace)
      macroDefinitions.push({
        name: target.name,
        args: parameterCount(parameterText),
        offset,
        line,
        definition: text.slice(offset, end),
        primitive: true
      })
      continue
    }

    // A command with no meaning to the scan: its arguments are skipped lazily, so
    // that a `\label` nested inside a known command's argument is still found by the
    // main loop rather than being consumed here.
  }

  // Reported in source order: an environment is *recorded* when it closes, so the
  // order they were discovered in is the order they ended, not the order they began.
  environments.sort((left, right) => left.beginOffset - right.beginOffset)

  return { labels, citations, macroDefinitions, environments, includedFiles, sectioning }
}
