import type { EditorState, Text } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'
import { getEnvironmentName } from '@/vendor/overleaf/utils/tree-operations/environments'

export interface EnvironmentInfo {
  startLine: number
  endLine: number
  name: string
  beginPos: number
  endPos: number
  beginFrom: number
  beginTo: number
  endFrom: number
  endTo: number
  depth: number
  treeMaxDepth: number
}

/**
 * Environments that must NOT have connecting brackets.
 * Connecting brackets belong to document/prose structural blocks (theorems,
 * proofs, definitions, lemmas, propositions, quotes, etc.), NOT math blocks
 * (equations, alignments, matrices, cases, etc.) or the outer document wrapper.
 */
export const EXCLUDED_ENVIRONMENTS = new Set([
  'document',
  // Math equation and display environments
  'equation',
  'align',
  'alignat',
  'flalign',
  'gather',
  'gathered',
  'multline',
  'eqnarray',
  'split',
  'aligned',
  'alignedat',
  'math',
  'displaymath',
  'subequations',
  'tikzcd',
  // Math matrices and arrays
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'smallmatrix',
  'psmallmatrix',
  'bsmallmatrix',
  'Bsmallmatrix',
  'vsmallmatrix',
  'Vsmallmatrix',
  'array',
  'subarray',
  // Cases environments
  'cases',
  'case',
  'dcases',
  'rcases',
  'drcases',
  // IEEE and custom equation variants
  'IEEEeqnarray',
  'IEEEeqnarraybox',
])

/**
 * Checks whether an environment should be excluded from receiving brackets.
 * Returns true if the environment is a math environment, inside a math container,
 * or the outer document environment.
 */
export function isExcludedEnvironment(
  name: string,
  node?: SyntaxNode | null
): boolean {
  if (!name) return true
  const baseName = name.replace(/\*$/, '').trim().toLowerCase()
  if (EXCLUDED_ENVIRONMENTS.has(baseName)) {
    return true
  }
  if (node) {
    let p = node.parent
    while (p) {
      if (
        p.type.is('$MathContainer') ||
        p.type.is('EquationEnvironment') ||
        p.type.is('EquationArrayEnvironment')
      ) {
        return true
      }
      p = p.parent
    }
  }
  return false
}


interface Branch {
  environment: EnvironmentInfo
  children: Branch[]
}

interface EnvironmentIndex {
  tree: Tree
  environments: EnvironmentInfo[]
  roots: Branch[]
}

// Selection and viewport transactions retain Text identity. Parse progress can
// replace the tree without changing Text, so both identities guard the cache.
// Keep only the latest tree per document; closed documents can be collected.
const indexes = new WeakMap<Text, EnvironmentIndex>()

function indexFor(state: EditorState): EnvironmentIndex {
  const tree = syntaxTree(state)
  const cached = indexes.get(state.doc)
  if (cached?.tree === tree) return cached

  const environments: EnvironmentInfo[] = []
  tree.iterate({
    enter(ref) {
      // Asking every syntax node for BeginEnv/EndEnv repeatedly walks sibling
      // lists. Only a BeginEnv can introduce an environment. Its matching end
      // is the last child of the containing grammar node in a complete parse.
      if (ref.type.is('$MathContainer') || ref.type.is('EquationEnvironment') ||
          ref.type.is('EquationArrayEnvironment')) return false
      if (ref.name !== 'BeginEnv') return
      const begin = ref.node
      const parent = begin.parent
      if (!parent) return false
      const last = parent.lastChild
      const end = last?.name === 'EndEnv' ? last : parent.getChild('EndEnv')
      if (!end) return false
      const name = getEnvironmentName(begin, state) || ''
      if (!name || name !== getEnvironmentName(end, state) || isExcludedEnvironment(name, parent)) return false
      environments.push({
        startLine: state.doc.lineAt(begin.from).number,
        endLine: state.doc.lineAt(end.to).number,
        name, beginPos: begin.from, endPos: end.to,
        beginFrom: begin.from, beginTo: begin.to,
        endFrom: end.from, endTo: end.to,
        depth: 0, treeMaxDepth: 0,
      })
      return false
    },
  })

  // The syntax traversal is already ordered. A stack builds the containment
  // forest and nesting depths in linear time, replacing all-pairs comparisons.
  const roots: Branch[] = []
  const stack: Branch[] = []
  let rootStart = 0
  let maximumDepth = 0
  const finishRoot = (end: number) => {
    for (let i = rootStart; i < end; i++) environments[i].treeMaxDepth = maximumDepth
  }
  for (let i = 0; i < environments.length; i++) {
    const environment = environments[i]
    while (stack.length && environment.endPos > stack[stack.length - 1].environment.endPos) stack.pop()
    if (!stack.length) {
      finishRoot(i)
      rootStart = i
      maximumDepth = 0
    }
    environment.depth = stack.length
    maximumDepth = Math.max(maximumDepth, environment.depth)
    const branch: Branch = { environment, children: [] }
    if (stack.length) stack[stack.length - 1].children.push(branch)
    else roots.push(branch)
    stack.push(branch)
  }
  finishRoot(environments.length)
  const index = { tree, environments, roots }
  indexes.set(state.doc, index)
  return index
}

/** Closed prose environments in document order, with their nesting metadata. */
export function findAllEnvironments(state: EditorState): EnvironmentInfo[] {
  return indexFor(state).environments
}

/** Query intersecting branches, skipping off-screen sibling subtrees by binary search. */
export function findEnvironmentsInRange(state: EditorState, from: number, to: number): EnvironmentInfo[] {
  const matches: EnvironmentInfo[] = []
  const visit = (siblings: Branch[]) => {
    let low = 0, high = siblings.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (siblings[middle].environment.endPos < from) low = middle + 1
      else high = middle
    }
    for (let i = low; i < siblings.length; i++) {
      const branch = siblings[i]
      if (branch.environment.beginPos > to) break
      matches.push(branch.environment)
      visit(branch.children)
    }
  }
  visit(indexFor(state).roots)
  return matches
}

/** Innermost eligible environment; math containers themselves never get brackets. */
export function findClosestEnvironment(state: EditorState, pos: number): EnvironmentInfo | null {
  const matches = findEnvironmentsInRange(state, pos, pos)
  const environment = matches[matches.length - 1]
  return environment ? { ...environment, depth: 0, treeMaxDepth: 0 } : null
}
