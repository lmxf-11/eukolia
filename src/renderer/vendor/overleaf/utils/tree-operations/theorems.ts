import { EditorState } from '@codemirror/state'
import { SyntaxNode, Tree } from '@lezer/common'
import {
  LongArg,
  ShortArg,
  ShortTextArgument,
  TextArgument,
} from '../../lezer-latex/latex.terms.mjs'
import { getProjectMacros } from '@/editor/projectMacros'
import { BUILT_IN_THEOREM_ENVIRONMENTS } from '@/visual/builtinPreamble'
import { projectIndex } from '@/document/projectIndex'
import { getEditorScope } from '@/visual/scope'

export interface TheoremDeclaration {
  name: string
  printName: string
  counter: string
  parentCounter?: string | null
  unnumbered?: boolean
}

export const parseTheoremArguments = (
  state: EditorState,
  node: SyntaxNode
): { name: string; label: string } | undefined => {
  const nameArgumentNode = node.getChild(ShortTextArgument)?.getChild(ShortArg)
  const labelArgumentNode = node.getChild(TextArgument)?.getChild(LongArg)

  if (nameArgumentNode && labelArgumentNode) {
    const name = state
      .sliceDoc(nameArgumentNode.from, nameArgumentNode.to)
      .trim()

    const label = state
      .sliceDoc(labelArgumentNode.from, labelArgumentNode.to)
      .trim()

    if (name && label) {
      return { name, label }
    }
  }
}

export const parseTheoremStyles = (state: EditorState, tree: Tree) => {
  let currentTheoremStyle = 'plain'
  const theoremStyles = new Map<string, string>()
  const topNode = tree.topNode
  if (topNode && topNode.name === 'LaTeX') {
    const textNode = topNode.getChild('Text')
    const topLevelCommands = textNode
      ? textNode.getChildren('Command')
      : topNode.getChildren('Command')
    for (const command of topLevelCommands) {
      const node = command.getChild('KnownCommand')?.getChild('$Command')
      if (node) {
        if (node.type.is('TheoremStyleCommand')) {
          const theoremStyle = argumentNodeContent(state, node)
          if (theoremStyle) {
            currentTheoremStyle = theoremStyle
          }
        } else if (node.type.is('NewTheoremCommand')) {
          const theoremEnvironmentName = argumentNodeContent(state, node)
          if (theoremEnvironmentName) {
            theoremStyles.set(theoremEnvironmentName, currentTheoremStyle)
          }
        }
      }
    }
  }
  return theoremStyles
}

const argumentNodeContent = (
  state: EditorState,
  node: SyntaxNode
): string | null => {
  const argumentNode = node.getChild(ShortTextArgument)?.getChild(ShortArg)

  return argumentNode
    ? state.sliceDoc(argumentNode.from, argumentNode.to)
    : null
}

/**
 * The two declaration syntaxes, at module scope so the scan cache below can use
 * them: `\newtheorem` with its optional shared counter and parent, and thmtools'
 * `\declaretheorem` with its options list.
 */
// \newtheorem*{env}{PrintName}
// \newtheorem{env}{PrintName}
// \newtheorem{env}{PrintName}[parent]
// \newtheorem{env}[shared]{PrintName}
const newtheoremRegex =
  /\\newtheorem(\*?)\s*\{([a-zA-Z0-9*_-]+)\}(?:\s*\[([a-zA-Z0-9*_-]+)\])?\s*\{([^}]+)\}(?:\s*\[([a-zA-Z0-9*_-]+)\])?/g

// \declaretheorem[opts]{env}
// \declaretheorem*{env}
const declaretheoremRegex =
  /\\declaretheorem(\*?)\s*(?:\[([^\]]*)\])?\s*\{([a-zA-Z0-9*_-]+)\}/g

/**
 * Declaration matches per source text, so the same text is never scanned twice.
 *
 * `parseAllTheoremDeclarations` runs inside **every decoration rebuild** — that is,
 * on every keystroke — and it scans the open document *and every source the project
 * index holds*: a project that `\input`s two hundred files means two megabytes of
 * text run through two regular expressions per character typed, measured at 2.0 ms
 * per keystroke. None of those sources change while the user types in a different
 * buffer, so the matches are remembered per text.
 *
 * Bounded, because the texts are whole files: the entry for a source that is no
 * longer registered is the oldest thing in the map and is dropped first. The keys
 * are the very strings the project index already keeps alive.
 */
const SCAN_CACHE_LIMIT = 256
interface DeclarationScan {
  newtheorem: RegExpExecArray[]
  declaretheorem: RegExpExecArray[]
}
const scanCache = new Map<string, DeclarationScan>()

/**
 * The matches for one source, computed once.
 *
 * `RegExpExecArray`s are stateful (`lastIndex`, `index`, `input`) and the caller
 * reads the capture groups, so what is stored is the list of arrays the parser
 * already needs — replaying them is pure assignment.
 */
function scanSource(src: string): DeclarationScan {
  const cached = scanCache.get(src)
  if (cached) {
    // Re-inserted so the eviction below drops the least recently *used*.
    scanCache.delete(src)
    scanCache.set(src, cached)
    return cached
  }

  const newtheorem: RegExpExecArray[] = []
  const declaretheorem: RegExpExecArray[] = []
  let match: RegExpExecArray | null

  newtheoremRegex.lastIndex = 0
  while ((match = newtheoremRegex.exec(src)) !== null) newtheorem.push(match)
  declaretheoremRegex.lastIndex = 0
  while ((match = declaretheoremRegex.exec(src)) !== null) declaretheorem.push(match)

  const scan = { newtheorem, declaretheorem }
  scanCache.set(src, scan)
  while (scanCache.size > SCAN_CACHE_LIMIT) {
    const oldest = scanCache.keys().next().value
    if (oldest === undefined) break
    scanCache.delete(oldest)
  }
  return scan
}

/**
 * Scans document text and project macros for all \newtheorem and \declaretheorem declarations.
 */
export function parseAllTheoremDeclarations(
  state: EditorState,
  tree?: Tree
): Map<string, TheoremDeclaration> {
  const declarations = new Map<string, TheoremDeclaration>()

  // 1. Seed with built-in theorem environments
  for (const name of BUILT_IN_THEOREM_ENVIRONMENTS) {
    const isUnnumbered = name === 'proof' || name === 'remark' || name === 'example' || name === 'notation'
    declarations.set(name, {
      name,
      printName: name.charAt(0).toUpperCase() + name.slice(1),
      counter: isUnnumbered ? '' : 'theorem',
      parentCounter: isUnnumbered ? null : 'section',
      unnumbered: isUnnumbered,
    })
  }

  // 2. Scan source texts: document text, project index sources, project macros, and scope
  const docText = state.doc.toString()
  const sources = [docText]
  /**
   * String equality, hashed once per text rather than compared per pair.
   *
   * `sources.includes(src)` is a scan of every source already collected, comparing
   * whole files: with two hundred registered sources that is two megabytes of string
   * comparison per candidate. A `Set` answers the same question with one hash per
   * text, which V8 caches on the string itself — and the notion of "already seen" is
   * identical, because it is the same equality.
   */
  const seenSources = new Set<string>([docText])

  const addSource = (source: string | undefined | null): void => {
    if (!source || seenSources.has(source)) return
    seenSources.add(source)
    sources.push(source)
  }

  try {
    for (const src of projectIndex.getAllSources()) addSource(src)
  } catch {
    // Project index not available in this scope
  }

  try {
    const macros = getProjectMacros()
    addSource(Object.values(macros).join('\n'))
  } catch {
    // Project macros not available in this scope
  }

  try {
    const scope = getEditorScope()
    if (scope) addSource(Object.values(scope.getMacroTable()).join('\n'))
  } catch {
    // Editor scope not available
  }

  // 3. Scan for any explicitly \input'ed or \include'd files in projectIndex
  const inputRegex = /\\(?:input|include)\s*\{([^}]+)\}/g
  let inputMatch: RegExpExecArray | null
  inputRegex.lastIndex = 0
  while ((inputMatch = inputRegex.exec(docText)) !== null) {
    const target = inputMatch[1].trim()
    try {
      const candidates = projectIndex.findFileCandidates(target, ['tex', 'ltx', 'sty', 'cls', 'def'])
      for (const candidate of candidates) {
        addSource(projectIndex.getExternalSource(candidate.path) || projectIndex.getDocument(candidate.path)?.getText())
      }
    } catch {
      // Ignore
    }
  }

  for (const src of sources) {
    // The regexes have already run over this text once — see `scanSource`.
    const scan = scanSource(src)

    for (const match of scan.newtheorem) {
      const isStarred = match[1] === '*'
      const envName = match[2].trim()
      const sharedCounter = match[3]?.trim()
      const printName = match[4].trim()
      const parentCounter = match[5]?.trim()

      declarations.set(envName, {
        name: envName,
        printName,
        counter: isStarred ? '' : (sharedCounter || envName),
        parentCounter: isStarred ? null : (parentCounter || (sharedCounter ? declarations.get(sharedCounter)?.parentCounter : null)),
        unnumbered: isStarred,
      })
    }

    // Parse \declaretheorem (thmtools)
    for (const match of scan.declaretheorem) {
      const isStarred = match[1] === '*'
      const opts = match[2] || ''
      const envName = match[3].trim()
      const nameMatch = opts.match(/\bname\s*=\s*(?:\{([^}]+)\}|([a-zA-Z0-9*_\s-]+))/i)
      const printName = (nameMatch?.[1] || nameMatch?.[2])?.trim() || (envName.charAt(0).toUpperCase() + envName.slice(1))
      const siblingMatch = opts.match(/\b(?:sibling|sharenumber)\s*=\s*([a-zA-Z0-9*_-]+)/i)
      const sharedCounter = siblingMatch?.[1]?.trim()
      const parentMatch = opts.match(/\b(?:parent|numberwithin)\s*=\s*([a-zA-Z0-9*_-]+)/i)
      const parentCounter = parentMatch?.[1]?.trim()
      const isUnnumbered = isStarred || /\bnumbered\s*=\s*(?:no|false|unless\s+unique)\b/i.test(opts)

      declarations.set(envName, {
        name: envName,
        printName,
        counter: isUnnumbered ? '' : (sharedCounter || envName),
        parentCounter: isUnnumbered ? null : (parentCounter || (sharedCounter ? declarations.get(sharedCounter)?.parentCounter : null)),
        unnumbered: isUnnumbered,
      })
    }
  }

  // Update counters that share with an env that declared a parentCounter later
  for (const decl of declarations.values()) {
    if (decl.counter && decl.counter !== decl.name && !decl.parentCounter) {
      const shared = declarations.get(decl.counter)
      if (shared?.parentCounter) {
        decl.parentCounter = shared.parentCounter
      }
    }
  }

  return declarations
}

/**
 * Tracks LaTeX counters for sections and theorems in document order to accurately reproduce PDF numbering.
 */
export class TheoremCounterManager {
  private counters = new Map<string, number>()
  public sectionIndex = 0
  public subsectionIndex = 0
  public subsubsectionIndex = 0
  public chapterIndex = 0

  constructor(private declarations: Map<string, TheoremDeclaration>) {}

  stepChapter(): void {
    this.chapterIndex++
    this.sectionIndex = 0
    this.subsectionIndex = 0
    this.subsubsectionIndex = 0
    this.resetSubordinates('chapter')
  }

  stepSection(): void {
    this.sectionIndex++
    this.subsectionIndex = 0
    this.subsubsectionIndex = 0
    this.resetSubordinates('section')
  }

  stepSubsection(): void {
    this.subsectionIndex++
    this.subsubsectionIndex = 0
    this.resetSubordinates('subsection')
  }

  stepSubsubsection(): void {
    this.subsubsectionIndex++
  }

  setCounter(counterName: string, val: number): void {
    if (counterName === 'section') {
      this.sectionIndex = val
      this.resetSubordinates('section')
    } else if (counterName === 'chapter') {
      this.chapterIndex = val
      this.resetSubordinates('chapter')
    } else {
      this.counters.set(counterName, val)
    }
  }

  private resetSubordinates(parent: string): void {
    for (const decl of this.declarations.values()) {
      if (decl.parentCounter === parent && decl.counter) {
        this.counters.set(decl.counter, 0)
      }
    }
  }

  formatNumber(envName: string): string {
    const decl = this.declarations.get(envName)
    if (!decl || decl.unnumbered || !decl.counter) {
      return ''
    }

    const current = (this.counters.get(decl.counter) ?? 0) + 1
    this.counters.set(decl.counter, current)

    if (decl.parentCounter === 'section') {
      // In PDF LaTeX, if section is 0 (before section 1), it outputs 0.1
      return `${this.sectionIndex}.${current}`
    } else if (decl.parentCounter === 'chapter') {
      return `${this.chapterIndex}.${current}`
    } else if (decl.parentCounter === 'subsection') {
      return `${this.sectionIndex}.${this.subsectionIndex}.${current}`
    } else {
      return `${current}`
    }
  }
}
