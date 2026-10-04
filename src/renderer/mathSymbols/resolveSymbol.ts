/**
 * Eukolia — choosing which spelling of a symbol to insert.
 *
 * The catalog knows one symbol may be written several ways; the project knows
 * which of those ways it actually runs. This module puts the two together and
 * ranks the result, and it is the one place in the feature where a wrong answer
 * is *silently* wrong: inserting `\mathbb{R}` where the document defines and
 * uses `\R` compiles and looks right, but it ignores the author's own notation,
 * which is precisely what `MathematicalSymbols.md` §7 asks not to do.
 *
 * The ranking is §7's, in its order:
 *
 *  1. a variant the user has preferred for this symbol, verified in scope;
 *  2. a unique, statically verified project alias for the exact construct;
 *  3. the canonical command, verified under the project's definitions and
 *     packages;
 *  4. the other verified equivalent spellings.
 *
 * Two refusals are as important as the ranking.
 *
 * **A redefined canonical command is not a candidate.** If the document says
 * `\renewcommand{\epsilon}{\varepsilon}` then `\epsilon` no longer draws ϵ, and
 * offering it for the epsilon entry would insert a symbol that looks like a
 * different one. The exception is the saved-original idiom, where the
 * redefinition is built out of a saved copy of the command itself — that
 * preserves the meaning and is kept, with a note.
 *
 * **Unverified is not available.** Nothing here promotes `unknown` to
 * `available` by default, because the whole point of tracking availability is
 * that the panel can be honest about the difference.
 */

import { bareCommand } from './commands'
import {
  variantSignature,
  type ProjectAliasIndex
} from './macroDefinition'
import type {
  Availability,
  AvailabilityStatus,
  CandidateOrigin,
  MathSymbolEntry,
  ProjectSymbolSnapshot,
  SymbolCandidate,
  SymbolVariant
} from './types'

/** The order the origins are ranked in; lower is better. */
const ORIGIN_RANK: Readonly<Record<CandidateOrigin, number>> = {
  'preferred-variant': 0,
  'project-alias': 1,
  canonical: 2,
  'equivalent-variant': 3,
  'project-macro': 4,
  'raw-code': 5
}

/**
 * Whether a variant's requirements are met, and what to say when they are not.
 *
 * Four outcomes, and the difference between the last two matters: a *missing*
 * package is a fact about the project, while an *unverified* requirement is a
 * fact about Eukolia's own metadata. Reporting the second as the first would
 * tell the user to install something they may already have.
 *
 * A satisfied requirement is never re-checked against `complete`: a package the
 * document loads is loaded, whatever else analysis is still doing. Only the
 * negative claim waits for analysis to finish.
 */
export function availabilityOf(
  variant: SymbolVariant,
  snapshot: ProjectSymbolSnapshot
): Availability {
  const requirements = variant.requires
  if (requirements.length === 0) {
    return {
      status: 'unknown',
      package: null,
      reason: 'no reviewed availability metadata for this command',
      verified: false
    }
  }

  const core = requirements.filter((requirement) => requirement.kind === 'core')
  const packages = requirements.filter((requirement) => requirement.kind !== 'core')
  const loaded = new Set(snapshot.packages)

  const missing = packages.filter((requirement) => !loaded.has(requirement.package.toLowerCase()))
  if (missing.length === 0) {
    if (packages.length === 0) {
      const verified = core.every((requirement) => requirement.verified)
      return {
        status: 'core',
        package: null,
        reason: verified
          ? 'part of the LaTeX kernel and base mathematics'
          : 'attributed to the LaTeX kernel, unverified',
        verified
      }
    }
    const names = packages.map((requirement) => requirement.package).join(', ')
    const verified = packages.every((requirement) => requirement.verified)
    return {
      status: 'project',
      package: packages[0].package,
      /*
       * Loading the named package is a fact about the project, so it establishes
       * availability even when the *attribution* was never reviewed — and the
       * reason says which of the two is which. The asymmetry is deliberate: an
       * unverified hint may not *deny* a command (see the missing branch below,
       * where it downgrades to `unknown` rather than to `missing-package`),
       * because the hint is parsed from free text and a wrong package name would
       * then hide a symbol that works.
       */
      reason: verified
        ? `this project loads ${names}`
        : `this project loads ${names}; Eukolia has not verified that ${names} provides this command`,
      verified
    }
  }

  const unverified = missing.filter((requirement) => !requirement.verified)
  if (unverified.length > 0) {
    return {
      status: 'unknown',
      package: unverified[0].package,
      reason: `needs ${unverified.map((requirement) => requirement.package).join(', ')}, which Eukolia has not verified`,
      verified: false
    }
  }

  if (!snapshot.complete) {
    return {
      status: 'unknown',
      package: missing[0].package,
      reason: `still checking which packages this project loads; ${missing[0].package} was not seen yet`,
      verified: true
    }
  }

  return {
    status: 'missing-package',
    package: missing[0].package,
    reason: `needs \\usepackage{${missing.map((requirement) => requirement.package).join(',')}}`,
    verified: true
  }
}

/** Whether a status permits the ordinary insert action. */
export const isInsertableStatus = (status: AvailabilityStatus): boolean =>
  status === 'core' || status === 'project'

export interface ResolveOptions {
  readonly entry: MathSymbolEntry
  readonly snapshot: ProjectSymbolSnapshot
  readonly aliases: ProjectAliasIndex
  /** `math-symbols.preferredVariants`, as `entryId → command`. */
  readonly preferredCommand?: string | null
  /** Where the insertion would go, which decides whether the mode fits. */
  readonly context?: 'math' | 'text' | 'unknown'
}

/**
 * Whether a project redefinition preserves the canonical meaning.
 *
 * The saved-original idiom is the reason this exists:
 *
 * ```latex
 * \let\origforall\forall
 * \renewcommand{\forall}{\origforall\,}
 * ```
 *
 * `\forall` has been redefined, so the strict reading says the canonical
 * command no longer means ∀ and must be withdrawn. That reading is wrong here:
 * the body names a saved copy of `\forall` itself, so the command still draws
 * the symbol — with a thin space added. Recognising it keeps `\forall` usable in
 * the projects that do this, which are exactly the projects fussy enough to
 * care.
 *
 * Anything else — `\renewcommand{\epsilon}{\varepsilon}`, `\def\R{\mathcal{R}}`
 * — is a genuine change of meaning and returns false.
 */
function redefinitionPreservesMeaning(
  macro: { readonly definition: string; readonly expansion: string | null },
  command: string,
  aliases: ProjectAliasIndex
): boolean {
  const body = macro.expansion
  if (!body) return false
  const head = /^\\([A-Za-z]+)/.exec(body)
  if (!head) return false
  const referenced = head[1]
  if (referenced === bareCommand(command)) return false

  /*
   * The saved copy has to be a *name for this command*, and the index is keyed
   * by the command a `\let` points at — so the question is whether the name the
   * body uses is the alias recorded for this spelling, not whether this
   * spelling is the alias recorded for that name. Asking it the wrong way round
   * is why `\forall` was withdrawn from exactly the projects that went to the
   * trouble of preserving it.
   */
  const savedByLet = aliases.byCommand.get(bareCommand(command))
  if (savedByLet && savedByLet.macro.name === referenced) return true

  // `\def\origforall{\forall}`: the saved copy is a body that expands to the
  // command itself, which is the same trick written a different way.
  const savedByDef = aliases.bySignature.get(`\\${referenced}`)
  return savedByDef !== undefined && savedByDef.macro.name === referenced
}

/**
 * Every candidate for an entry, best first.
 *
 * The list is a ranking, not a filter: the panel shows the best candidate's code
 * and offers the alternatives, which is what §7 means by "retain the verified
 * canonical spelling by default and expose alternatives".
 */
export function resolveCandidates(options: ResolveOptions): SymbolCandidate[] {
  const { entry, snapshot, aliases, context = 'unknown' } = options
  const candidates: SymbolCandidate[] = []

  entry.variants.forEach((variant, index) => {
    const availability = availabilityOf(variant, snapshot)
    const signature = variantSignature(variant.parts, variant.slots.length)    /*
     * The spelling this variant is *about*.
     *
     * A variant whose `command` is `null` is a complete expression rather than a
     * control sequence — the curated `\mathbb{R}`, or a multi-part template. It
     * has no name to be redefined, and no name for a project alias to be another
     * name *for*; falling back to the entry's display name here is what used to
     * turn `cur:reals` into a `TypeError` the moment the panel resolved it.
     */
    const spelling = variant.command
    const bare = spelling === null ? null : bareCommand(spelling)
    const redefinition = bare === null ? undefined : aliases.redefined.get(bare)
    const preserved =
      bare === null ||
      redefinition === undefined ||
      redefinitionPreservesMeaning(redefinition, spelling!, aliases)

    const notes: string[] = []
    if (bare !== null && redefinition && preserved) {
      notes.push(
        `\\${bare} is redefined in this project in terms of itself; the symbol is unchanged`
      )
    }
    if (bare !== null && redefinition && !preserved) {
      notes.push(`\\${bare} is redefined in this project to mean something else`)
    }
    if (!availability.verified && availability.status !== 'core') {
      notes.push('the package requirement for this spelling has not been verified')
    }

    const modeFits = !(variant.mode === 'text-only' && context === 'math')
    const blocked = !preserved || !modeFits
    const modeNote = modeFits
      ? null
      : 'this command is text-only and the caret is in mathematics'

    // The canonical spelling, when the project has not redefined it away.
    if (preserved && !blocked) {
      candidates.push({
        entryId: entry.id,
        variantId: variant.id,
        command: spelling ?? entry.name,
        origin: index === 0 ? 'canonical' : 'equivalent-variant',
        availability,
        mode: variant.mode,
        selfContainedMath: variant.selfContainedMath,
        declaredAt: null,
        notes,
        insertable: isInsertableStatus(availability.status)
      })
    }

    // A project alias that denotes exactly this construct.
    const expressionAlias = signature ? aliases.bySignature.get(signature) : undefined
    if (expressionAlias && expressionAlias.kind === 'expression') {
      candidates.push({
        entryId: entry.id,
        variantId: `${variant.id}@project:${expressionAlias.macro.name}`,
        command: `\\${expressionAlias.macro.name}`,
        origin: 'project-alias',
        availability,
        mode: variant.mode,
        selfContainedMath: variant.selfContainedMath,
        declaredAt: { file: expressionAlias.macro.file, line: expressionAlias.macro.line },
        aliasArgCount: expressionAlias.macro.args,
        notes: [
          `this project defines \\${expressionAlias.macro.name} as ${expressionAlias.macro.definition.trim()}`
        ],
        insertable: isInsertableStatus(availability.status) && modeFits
      })
    }

    // Another name for the control sequence itself — `\let\R\mathbb`.
    const commandAlias = bare === null ? undefined : aliases.byCommand.get(bare)
    if (commandAlias && commandAlias.kind === 'command') {
      candidates.push({
        entryId: entry.id,
        variantId: `${variant.id}@command:${commandAlias.macro.name}`,
        command: `\\${commandAlias.macro.name}`,
        origin: 'project-alias',
        availability,
        mode: variant.mode,
        selfContainedMath: variant.selfContainedMath,
        declaredAt: { file: commandAlias.macro.file, line: commandAlias.macro.line },
        aliasArgCount: commandAlias.macro.args,
        notes: [
          `this project defines \\${commandAlias.macro.name} as another name for ${commandAlias.targetCommand}`
        ],
        insertable: isInsertableStatus(availability.status) && modeFits
      })
    }

    if (blocked && modeNote) notes.push(modeNote)
  })

  const preferred = options.preferredCommand
  if (preferred) {
    const match = candidates.find(
      (candidate) => candidate.command === preferred || candidate.variantId === preferred
    )
    if (match) {
      candidates.splice(candidates.indexOf(match), 1)
      candidates.unshift({ ...match, origin: 'preferred-variant' })
    }
  }

  return candidates.sort(
    (a, b) =>
      ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] ||
      Number(b.insertable) - Number(a.insertable) ||
      a.command.length - b.command.length ||
      a.command.localeCompare(b.command)
  )
}

/** The candidate the panel's insert button uses, or `null` when there is none. */
export function bestCandidate(candidates: readonly SymbolCandidate[]): SymbolCandidate | null {
  return candidates.find((candidate) => candidate.insertable) ?? null
}

/**
 * Why an entry cannot be inserted, phrased for the details pane.
 *
 * Separate from the ranking because the panel needs it when the ranking is
 * empty — the symbol is still shown, still searchable, and still explains
 * itself, which is what §7 asks for a command with a missing dependency.
 */
export function unavailableExplanation(candidates: readonly SymbolCandidate[]): string {
  if (candidates.length === 0) return 'no spelling of this symbol is known'
  const first = candidates[0]
  if (first.availability.status === 'missing-package') {
    return `${first.availability.reason}. Copy the code, or add the package to the preamble yourself.`
  }
  if (first.availability.status === 'unknown') {
    return `${first.availability.reason}. Eukolia will not claim this command is available.`
  }
  return first.notes[0] ?? first.availability.reason
}
