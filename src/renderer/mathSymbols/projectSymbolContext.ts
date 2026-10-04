/**
 * Eukolia — the project facts a symbol insertion depends on.
 *
 * This module is the *pure* half of the project context: it turns plain data —
 * the macros an analysis found, the files the compilation root reaches, the
 * packages the sources load — into an immutable `ProjectSymbolSnapshot` with a
 * revision. It reads no file, subscribes to nothing and holds no state, so the
 * rules that decide which commands a project has are testable on their own,
 * without an editor, a workspace or Electron.
 * `projectSymbolService.ts` is the other half: it watches the application and
 * calls this.
 *
 * Two of the rules here are the ones that are easy to get wrong and expensive to
 * get wrong.
 *
 * **Scope is not "everything the index knows".** `projectIndex` merges the
 * macros of every *open document*, and an open document is frequently not part
 * of the compilation the caret's file belongs to. A `macros.tex` from another
 * project sitting in a tab must not supply `\R`. So a declaration counts as in
 * scope only when its file is the active document or a file the compilation
 * root actually reaches — and §6's harder cases (source order, conditionals,
 * repeated inclusion) are reported as *uncertain* rather than resolved.
 *
 * **An uncertain declaration is still a fact.** It is kept, with its provenance
 * and the reason it is uncertain, because §7 asks for such a command to remain
 * discoverable and explainable. Dropping it would make the panel claim the
 * command does not exist, which is a different and worse claim than "it exists
 * and Eukolia cannot prove what it means".
 */

import {
  canonicalExpression,
  parseMacroDeclaration
} from './macroDefinition'
import type {
  ContextLimitations,
  MacroDeclarationKind,
  ProjectMacro,
  ProjectSymbolInclusion,
  ProjectSymbolSnapshot
} from './types'

/** A macro declaration as the analysis reports it. */
export interface RawMacroDeclaration {
  readonly name: string
  readonly args: number
  /** Absolute path of the declaring file, or `null` for an unsaved buffer. */
  readonly file: string | null
  readonly line: number
  /** The full source of the declaration. */
  readonly definition: string
}

/** Everything the snapshot is built from. */
export interface ProjectSymbolSnapshotInput {
  readonly workspaceRoot: string | null
  /** The file the compilation starts from, when one was detected or chosen. */
  readonly compilationRoot: string | null
  /** The document the caret is in, which is always in scope for itself. */
  readonly activeDocumentPath: string | null
  /** Every source the compilation root reaches, normalised. */
  readonly reachableSources: readonly string[]
  readonly macros: readonly RawMacroDeclaration[]
  /** Package names the sources load, lower-cased. */
  readonly packages: readonly string[]
  /** The engine the project compiles with, from the compilation settings. */
  readonly engine: string | null
  /** Include edges, when the analysis produced them. */
  readonly inclusions?: readonly ProjectSymbolInclusion[]
  /** Whether analysis has finished for this root. */
  readonly complete: boolean
  /** Extra sentences about what was not analysed. */
  readonly notes?: readonly string[]
  /** True when a bound stopped the include walk early. */
  readonly truncated?: boolean
}

/** Normalises a path the way every comparison in this feature does. */
export const normalizeSourcePath = (value: string | null | undefined): string | null => {
  if (!value) return null
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Builds a snapshot.
 *
 * `revision` is supplied by the caller rather than derived, because only the
 * caller knows whether this snapshot replaces the previous one or is a stale
 * result arriving late. Revisions only ever increase.
 */
export function buildProjectSymbolSnapshot(
  input: ProjectSymbolSnapshotInput,
  revision: number
): ProjectSymbolSnapshot {
  const active = normalizeSourcePath(input.activeDocumentPath)
  const reachable = new Set<string>()
  for (const source of input.reachableSources) {
    const normalized = normalizeSourcePath(source)
    if (normalized) reachable.add(normalized)
  }
  const compilationRoot = normalizeSourcePath(input.compilationRoot)
  if (compilationRoot) reachable.add(compilationRoot)
  if (active) reachable.add(active)

  const macros: ProjectMacro[] = []
  for (const raw of input.macros) {
    const parsed = parseMacroDeclaration(raw.definition, raw.name, raw.args)
    if (parsed.kind === 'newenvironment') continue
    const file = normalizeSourcePath(raw.file)
    const scope = scopeOf(file, active, reachable, compilationRoot)
    macros.push({
      name: parsed.name.replace(/^\\/, ''),
      kind: parsed.kind,
      args: parsed.args,
      definition: raw.definition,
      expansion: canonicalExpression(parsed.body),
      letTarget: parsed.letTarget,
      file: raw.file,
      line: raw.line,
      inScope: scope.inScope,
      uncertainty: scope.uncertainty
    })
  }

  // Last declaration wins within one file, which is what LaTeX does; across
  // files, the later line number wins. The list is kept sorted so two runs over
  // the same data produce the same snapshot, whatever order the index reported.
  macros.sort((a, b) => a.name.localeCompare(b.name) || a.line - b.line)

  const packages = [...new Set(input.packages.map((name) => name.toLowerCase()))].sort()

  const limitations: ContextLimitations = {
    root: input.compilationRoot,
    truncated: input.truncated === true,
    notes: (input.notes ?? []).slice()
  }

  return Object.freeze({
    revision,
    workspaceRoot: input.workspaceRoot,
    compilationRoot: input.compilationRoot,
    complete: input.complete,
    macros: Object.freeze(macros),
    packages: Object.freeze(packages),
    engine: input.engine,
    inclusions: Object.freeze((input.inclusions ?? []).slice()),
    limitations
  })
}

/**
 * Whether a declaring file is in scope, and why not when it is not.
 *
 * A declaration in the active document is always usable: the user is looking at
 * it. Anything else has to be reachable from the compilation root. When there is
 * no compilation root at all — a standalone file opened on its own — nothing
 * outside the active document is claimed, which is what §6 asks for: "do not
 * borrow macros from unrelated open projects".
 *
 * The uncertainty text is deliberately about the *limit*, not about the
 * declaration: Eukolia cannot prove the include order, so it says so rather than
 * asserting either that the macro is defined or that it is not.
 */
function scopeOf(
  file: string | null,
  active: string | null,
  reachable: ReadonlySet<string>,
  compilationRoot: string | null
): { inScope: boolean; uncertainty: string | null } {
  if (file === null) {
    // An unsaved buffer: it is the active document or it is not analysable.
    return active === null
      ? { inScope: true, uncertainty: null }
      : { inScope: false, uncertainty: 'declared in an unsaved buffer that is not the active document' }
  }
  if (active !== null && file === active) return { inScope: true, uncertainty: null }
  if (reachable.has(file)) {
    return {
      inScope: true,
      uncertainty:
        'the include order was not modelled, so Eukolia cannot prove this declaration runs before the insertion point'
    }
  }
  return {
    inScope: false,
    uncertainty:
      compilationRoot === null
        ? 'declared in a file that is not the active document, and no compilation root is known'
        : 'declared in a file the compilation root does not include'
  }
}

/** A macro's declaration kind as a word for the panel. */
export function describeMacroKind(kind: MacroDeclarationKind): string {
  switch (kind) {
    case 'newcommand':
      return '\\newcommand'
    case 'renewcommand':
      return '\\renewcommand'
    case 'providecommand':
      return '\\providecommand'
    case 'def':
      return '\\def'
    case 'let':
      return '\\let'
    case 'DeclareMathOperator':
      return '\\DeclareMathOperator'
    case 'newenvironment':
      return '\\newenvironment'
    default:
      return 'declaration'
  }
}
