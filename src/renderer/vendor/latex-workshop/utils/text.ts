/**
 * Eukolia — LaTeX Workshop port: pure text utilities.
 *
 * Ported from `out/src/utils/utils.js` of LaTeX Workshop 10.19.0. The functions
 * that only touched VS Code configuration now take the resolved
 * `LwSettings` explicitly; the algorithms are unchanged.
 */

import { settingOr, type LwSettings } from '../settings'

export function escapeRegExp(str: string): string {
  return str.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&')
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Strip text and comments from LaTeX, leaving only macros and environments.
 *
 * @param raw The raw LaTeX content as a string
 * @returns The stripped LaTeX macro barebone
 */
export function stripText(raw: string): string {
  const text = stripComments(raw)
  // We first create an array of empty strings, each of which corresponds to
  // one line in the original document.
  const result: string[] = Array(text.split('\n').length).fill('')
  // The following regex defines a LaTeX macro.
  // We also consider a special case of verbatim "label={something}"
  const macroReg = /(\\(?:[^a-zA-Z@]|[a-zA-Z@]+[*=']?)\s*)|(label={[^{}]+})/gm
  let match: RegExpExecArray | null
  while ((match = macroReg.exec(text)) !== null) {
    // Stores the complete macro, including arguments.
    let matchedText = match[0]
    // match[1]: macro, null on "label={something}"
    // There is an (optional) argument after the macro. They can be many.
    while (['{', '['].includes(text[macroReg.lastIndex])) {
      const isCurly = text[macroReg.lastIndex] === '{'
      const balanceStr = getLongestBalancedString(text.substring(macroReg.lastIndex), isCurly ? undefined : 'square')
      if (balanceStr === undefined) {
        // \in[1, 2]
        break
      }
      matchedText += isCurly ? `{${balanceStr}}` : `[${balanceStr}]`
      macroReg.lastIndex += balanceStr.length + 2
      // It's possible to have spaces between arguments. If so, skip them.
      while (text[macroReg.lastIndex] === ' ' || text[macroReg.lastIndex] === '\t') {
        macroReg.lastIndex++
      }
    }
    const line = text.substring(0, match.index).split('\n').length - 1
    // Append each line in the macro to the array.
    matchedText.split('\n').forEach((content, index) => (result[line + index] += content))
  }
  return result.join('\n')
}

/**
 * Remove comments.
 *
 * Note the number of lines of the output matches the input.
 */
export function stripComments(text: string): string {
  const reg = /(^|[^\\]|(?:(?<!\\)(?:\\\\)+))%(?![2-9A-F][0-9A-F]).*$/gm
  return text.replace(reg, '$1')
}

/**
 * Remove some verbatim-like environments.
 * Note the number of lines of the output matches the input.
 * Verbatim content is replaced by empty lines.
 */
export function stripEnvironments(text: string, envs: string[]): string {
  if (envs.length === 0) {
    return text
  }
  // Build alternation of environment names, each with optional star
  const envPatterns = envs.map((env) => `${env}\\*?`).join('|')
  const pattern = `\\\\begin{(${envPatterns})}.*?\\\\end{\\1}`
  const reg = new RegExp(pattern, 'gmsi')
  return text.replace(reg, (match) => {
    const len = Math.max(match.split('\n').length, 1)
    return '\n'.repeat(len - 1)
  })
}

/**
 * Remove comments and verbatim content.
 * Note that the positions are preserved between the input and the output:
 *  - verbatim environments are replaced by as many empty lines
 *  - inline verbatim content is replaced by as many white spaces
 */
export function stripCommentsAndVerbatim(text: string, settings: LwSettings): string {
  let content = stripComments(text)
  content = content.replace(/\\verb\*?([^a-zA-Z0-9]).*?\1/g, (m) => ' '.repeat(m.length))
  const verbatimEnvs = settingOr<string[]>(settings, 'latex.verbatimEnvs', ['verbatim', 'lstlisting', 'minted'])
  return stripEnvironments(content, verbatimEnvs)
}

/** Trim leading and ending spaces on every line. */
export function trimMultiLineString(text: string): string {
  return text.replace(/^\s\s*/gm, '').replace(/\s\s*$/gm, '')
}

/**
 * Find the longest substring containing balanced curly braces {...}
 * The string `s` can either start on the opening `{` or at the next character.
 */
export function getLongestBalancedString(s: string, bracket: 'curly' | 'square' = 'curly'): string | undefined {
  const bracketStack: string[] = []
  const opener = bracket === 'curly' ? '{' : '['
  if (s[0] !== opener) {
    bracketStack.push(opener)
  }
  for (let i = 0; i < s.length; ++i) {
    const char = s[i]
    if (char === '{' || char === '[' || char === '(') {
      bracketStack.push(char)
    } else if (char === '}') {
      const openPos = bracketStack.lastIndexOf('{')
      if (openPos > -1) {
        bracketStack.splice(openPos, 1)
      }
    } else if (char === ']') {
      const openPos = bracketStack.lastIndexOf('[')
      if (openPos > -1) {
        bracketStack.splice(openPos, 1)
      }
    } else if (char === ')') {
      const lastBracket = bracketStack[bracketStack.length - 1]
      if (lastBracket === '(' || lastBracket === '[') {
        bracketStack.pop()
      }
    }
    if (bracketStack.lastIndexOf(opener) < 0) {
      return s.substring(s[0] === opener ? 1 : 0, i)
    }
  }
  return undefined
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
