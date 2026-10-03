/**
 * Eukolia — glob matching for `FileProvider.findFiles`.
 *
 * Mirrors the subset of `micromatch`/VS Code globbing the reference relies on
 * for `latex.search.rootFiles.include` / `exclude`: `**`, `*`, `?`, `{a,b}`
 * alternation and `[abc]` classes, matched case-insensitively against absolute
 * paths.
 */

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]
  let depth = 0
  let close = -1
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++
    else if (pattern[i] === '}') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1) return [pattern]
  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  const options = splitTopLevel(pattern.slice(open + 1, close))
  return options.flatMap((option) => expandBraces(prefix + option + suffix))
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

const regexpCache = new Map<string, RegExp>()

export function globToRegExp(pattern: string): RegExp {
  const cached = regexpCache.get(pattern)
  if (cached) return cached

  const normalized = pattern.replace(/\\/g, '/')
  let source = ''
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]
    if (ch === '*') {
      const isDouble = normalized[i + 1] === '*'
      if (isDouble) {
        const isSlashAfter = normalized[i + 2] === '/'
        if (isSlashAfter) {
          source += '(?:[^/]*(?:/|$))*'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else if (ch === '[') {
      const end = normalized.indexOf(']', i)
      if (end === -1) {
        source += '\\['
      } else {
        source += normalized.slice(i, end + 1)
        i = end
      }
    } else {
      source += ch.replace(/[.+^${}()|\\]/g, '\\$&')
    }
  }

  const regexp = new RegExp(`^${source}$`, 'i')
  regexpCache.set(pattern, regexp)
  return regexp
}

/** True when the absolute `candidate` matches `pattern` (relative or absolute). */
export function globMatches(pattern: string, candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, '/')
  return expandBraces(pattern).some((p) => {
    const candidatePattern = p.replace(/\\/g, '/')
    if (globToRegExp(candidatePattern).test(normalized)) {
      return true
    }
    // Relative patterns (`**/*.tex`) match at any depth of the absolute path.
    if (!candidatePattern.startsWith('/') && !/^[A-Za-z]:/.test(candidatePattern)) {
      return globToRegExp(`**/${candidatePattern}`).test(normalized)
    }
    return false
  })
}
