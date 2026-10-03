/**
 * Eukolia — LaTeX tokenizer for syntax highlighting.
 *
 * The patterns are the ones LaTeX Workshop ships in
 * `syntax/LaTeX.tmLanguage.json`, copied to
 * `src/renderer/data/latex-workshop/LaTeX.tmLanguage.json`. This module turns
 * the grammar's top-level rules into a single-pass scanner that produces
 * non-overlapping tokens with source offsets, which the Monaco adapter maps to
 * semantic-highlighting token types.
 *
 * Each rule keeps the grammar's own regular expression and the scope name the
 * grammar assigns to it, so the colouring stays the reference's rather than an
 * invention. `tokenizeLatex` is the only entry point; the rule table is exported
 * for tests.
 */

export type LatexTokenType =
  | 'comment'
  | 'command'
  | 'environment'
  | 'environmentName'
  | 'mathBlock'
  | 'mathInline'
  | 'citation'
  | 'reference'
  | 'label'
  | 'section'
  | 'definition'
  | 'package'
  | 'class'
  | 'include'
  | 'verbatim'
  | 'parameter'

export interface LatexToken {
  type: LatexTokenType
  /** TextMate scope of the originating grammar rule. */
  scope: string
  /** Character offset of the first character. */
  start: number
  /** Character offset one past the last character. */
  end: number
  text: string
}

/** A grammar rule: a `begin`/`end` pair or a single-line `match`. */
export interface GrammarRule {
  type: LatexTokenType
  /** The grammar's `name` attribute. */
  scope: string
  /** The grammar's `contentName`, applied to the text between begin and end. */
  contentScope?: string
  /** Sticky regular expression, matched at the scanner position. */
  match: RegExp
  /** Stop pattern for span rules; the span ends after the first match. */
  end?: RegExp
  /** For span rules whose end is a closing brace, stop at the balanced brace. */
  braceBalanced?: boolean
  /** Stop at the end of the line (single-line rules). */
  lineScoped?: boolean
}

function sticky(source: string): RegExp {
  return new RegExp(source, 'y')
}

/**
 * Span terminators are *searched* for, not anchored: `\[` … `\]` and
 * `\begin{verbatim}` … `\end{verbatim}` have to be located after the opening
 * match, unlike the rule patterns which are anchored at the scanner position.
 * The `g` flag is what makes `lastIndex` take effect.
 */
function search(source: string): RegExp {
  return new RegExp(source, 'g')
}

/**
 * The rules, in the grammar's order (top-level `patterns`, then the `#braces`
 * recursion). The first rule that matches at the scanner position wins.
 *
 * The `%` comment rule is the one exception: the grammar delegates line comments
 * to the external `text.tex` grammar, which LaTeX Workshop ships separately and
 * which is not part of `LaTeX.tmLanguage.json`. The standard LaTeX comment
 * syntax is used so comments are still classified.
 */
export const GRAMMAR_RULES: GrammarRule[] = [
  {
    type: 'comment',
    scope: 'comment.line.percentage.latex',
    match: sticky('(?<!\\\\)%(?![2-9A-F][0-9A-F])'),
    end: search('\\n'),
    lineScoped: true
  },
  {
    type: 'verbatim',
    scope: 'meta.function.verbatim.latex',
    contentScope: 'markup.raw.verbatim.latex',
    match: sticky('\\s*\\\\begin\\{((?:fboxv|boxedv|V|v|spv)erbatim\\*?|Verbatim\\*?|BVerbatim\\*?|LVerbatim\\*?|lstlisting|minted|alltt|[Cc]omment)\\}'),
    end: search('\\\\end\\{(?:(?:fboxv|boxedv|V|v|spv)erbatim\\*?|Verbatim\\*?|BVerbatim\\*?|LVerbatim\\*?|lstlisting|minted|alltt|[Cc]omment)\\}')
  },
  {
    type: 'environment',
    scope: 'meta.function.environment.latex',
    match: sticky('\\\\(?:begin|end)\\s*\\{'),
    braceBalanced: true
  },
  {
    type: 'package',
    scope: 'meta.preamble.latex',
    match: sticky('(\\\\)(?:usepackage|RequirePackage)\\b(?=\\[|\\{)'),
    braceBalanced: true
  },
  {
    type: 'class',
    scope: 'meta.preamble.latex',
    match: sticky('(\\\\)(?:documentclass)\\b(?=\\[|\\{)'),
    braceBalanced: true
  },
  {
    type: 'include',
    scope: 'meta.include.latex',
    match: sticky('(\\\\)(?:include|input|subfile|subfileinclude|includeonly|import|subimport|includefrom|inputfrom|subincludefrom|subinputfrom|loadglsentries|markdownInput)(\\{)'),
    braceBalanced: true
  },
  {
    type: 'section',
    scope: 'meta.function.section.latex',
    contentScope: 'entity.name.section.latex',
    match: sticky(
      '((\\\\)((?:sub){0,2}section|(?:sub)?paragraph|chapter|part|addpart|addchap|addsec|minisec|frametitle)(?:\\*)?)((?:\\[[^\\[]*?\\]){0,2})(\\{)'
    ),
    braceBalanced: true
  },
  {
    type: 'citation',
    scope: 'meta.citation.latex',
    match: sticky(
      '((\\\\)(?:[aA]uto|foot|full|footfull|no|ref|short|[tT]ext|[pP]aren|[sS]mart|[fFpP]vol|vol)?[cC]ite(?:al)?(?:p|s|t|author|year(?:par)?|title|url|date)?[ANP]*\\*?)((?:\\[[^\\]]*\\])*)(\\{)'
    ),
    braceBalanced: true
  },
  {
    type: 'reference',
    scope: 'meta.reference.label.latex',
    match: sticky('((\\\\)(?:\\w*[rR]ef\\*?))(?:\\[[^\\]]*\\])?(\\{)'),
    braceBalanced: true
  },
  {
    type: 'label',
    scope: 'meta.definition.label.latex',
    match: sticky('((\\\\)z?label)((?:\\[[^\\[]*?\\])*)(\\{)'),
    braceBalanced: true
  },
  {
    type: 'definition',
    scope: 'meta.parameter.newcommand.latex',
    match: sticky(
      '((\\\\)(?:newcommand|renewcommand|providecommand|(?:re)?newrobustcmd|DeclareRobustCommand|DeclareMathOperator|newenvironment|renewenvironment)\\*?)(\\{)?((\\\\)[\\p{Alphabetic}@]+\\*?|\\{?[\\p{Alphabetic}@]+\\}?)?(\\})?(?:(\\[)[^\\]]*(\\])){0,2}(\\{)'
    ),
    braceBalanced: true
  },
  {
    type: 'verbatim',
    scope: 'meta.function.verb.latex',
    match: sticky('((\\\\)(?:verb|Verb|spverb)\\*?)\\s*((?<=\\s)\\S|[^a-zA-Z])(.*?)(\\3|$)')
  },
  {
    type: 'mathBlock',
    scope: 'meta.math.block.latex',
    match: sticky('\\\\\\['),
    end: search('\\\\\\]')
  },
  {
    type: 'mathBlock',
    scope: 'meta.math.block.latex',
    match: sticky('\\$\\$'),
    end: search('\\$\\$')
  },
  {
    type: 'mathInline',
    scope: 'meta.math.block.tex',
    match: sticky('\\\\\\('),
    end: search('\\\\\\)')
  },
  {
    type: 'mathInline',
    scope: 'meta.math.block.tex',
    match: sticky('\\$(?!\\$)'),
    end: search('(?<!\\$)\\$'),
    lineScoped: true
  },
  {
    type: 'command',
    scope: 'keyword.control.latex',
    match: sticky('\\\\(?:[\\p{Alphabetic}@]+|.)')
  }
]

/**
 * Offset just past the `{...}` group starting at `start`, honouring `\{`
 * escapes. Returns `text.length` for an unterminated group, so incomplete typing
 * still yields a token.
 */
export function braceEnd(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') {
      i += 1
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return i + 1
      }
    }
  }
  return text.length
}

/** End of the line containing `start` (excluding the newline). */
function lineEnd(text: string, start: number): number {
  const index = text.indexOf('\n', start)
  return index === -1 ? text.length : index
}

/**
 * Tokenize LaTeX source into non-overlapping grammar tokens, in source order.
 */
export function tokenizeLatex(text: string): LatexToken[] {
  const tokens: LatexToken[] = []
  let index = 0

  while (index < text.length) {
    let matched = false
    for (const rule of GRAMMAR_RULES) {
      rule.match.lastIndex = index
      const result = rule.match.exec(text)
      if (!result || result.index !== index) {
        continue
      }
      const start = index
      let end: number
      if (rule.braceBalanced) {
        // Span to the balanced brace that closes the command's argument.
        const open = text.indexOf('{', start + result[0].length - 1)
        end = open === -1 ? start + result[0].length : braceEnd(text, open)
      } else if (rule.end) {
        rule.end.lastIndex = start + result[0].length
        const close = rule.end.exec(text)
        end = close ? close.index + close[0].length : lineEnd(text, start)
      } else {
        end = start + result[0].length
      }
      if (rule.lineScoped) {
        end = Math.min(end, lineEnd(text, start))
      }
      if (end <= start) {
        end = start + result[0].length
      }
      tokens.push({
        type: rule.type,
        scope: rule.scope,
        start,
        end,
        text: text.slice(start, end)
      })
      index = end
      matched = true
      break
    }
    if (!matched) {
      index += 1
    }
  }

  return tokens
}

/** Tokens of one kind, e.g. every `\input`-like include. */
export function tokensOfType(tokens: LatexToken[], type: LatexTokenType): LatexToken[] {
  return tokens.filter((token) => token.type === type)
}

/**
 * Suggested mapping onto Monaco's standard semantic token types, for the editor
 * adapter. Monaco has no LaTeX-specific legend, so each grammar scope is mapped
 * to the closest standard type; `LatexToken.scope` always carries the original
 * TextMate scope when a more faithful theme mapping is wanted.
 */
export const SUGGESTED_MONACO_SEMANTIC_TYPES: Record<LatexTokenType, string> = {
  comment: 'comment',
  command: 'keyword',
  environment: 'type',
  environmentName: 'type',
  mathBlock: 'number',
  mathInline: 'number',
  citation: 'namespace',
  reference: 'label',
  label: 'label',
  section: 'class',
  definition: 'macro',
  package: 'namespace',
  class: 'class',
  include: 'string',
  verbatim: 'string',
  parameter: 'parameter'
}