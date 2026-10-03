/**
 * Project macro definitions for the Visual Editor's mathematical typesetting.
 *
 * LaTeX projects keep their macros in one file that the root document
 * `\input`s, so the mathematics in every chapter uses macros that are *not*
 * defined in the chapter's own source. MathJax has to be told about them or the
 * mathematics cannot be typeset — and it fails **silently**: an undefined control
 * sequence renders as its own name, so `\R` comes out as a plain italic R rather
 * than blackboard bold, with no error anywhere.
 *
 * Two places typeset mathematics and both need the same definitions:
 *
 *  * `atomic-decorations.ts` builds the preamble a `MathWidget` is constructed
 *    with, from the definitions in the document's own preamble — the reference's
 *    behaviour, and correct as far as it goes;
 *  * `math-preview.ts` typesets the floating preview from the `documentCommands`
 *    and `documentEnvironments` projections, which are likewise one file's.
 *
 * Neither can see another file, and neither should have to: the project's macros
 * are a *project* fact. This module is where they live. `ProjectIndex` gathers
 * them (`WorkspaceService.indexIncludedSourceFiles` reads the files a document
 * includes, and open buffers contribute their own), the host keeps the value here
 * up to date, and the two typesetting sites read it at the moment they typeset
 * rather than being handed a snapshot when the editor was created.
 *
 * A `Compartment` rather than a plain module variable because the editor is built
 * once and macros arrive *later*: the project index finishes reading the included
 * files after the first paint, and the user may edit the macro file at any time. A
 * change is therefore a *transaction*, and `atomic-decorations.ts` rebuilds its
 * widgets on it — a `MathWidget` holds its preamble from construction, so that
 * rebuild is the only thing that can typeset the mathematics already on screen
 * again.
 */

import { Compartment, StateEffect, StateField, type Extension } from '@codemirror/state'

import { parseLatexWithArguments } from '../vendor/latex-workshop/parser/unified'
import { collectMacroDefinitions } from '../vendor/latex-workshop/parser/newcommand'

/** Project-wide macros: name including the backslash -> the definition's source. */
export type MacroTable = Record<string, string>

const NO_MACROS: MacroTable = Object.freeze({})

/**
 * The table typesetting reads.
 *
 * Deliberately readable without the editor state: the typesetting calls happen
 * from widget callbacks and promise continuations that have no `EditorState` to
 * hand, and the question they ask ("what macros does this project define") has
 * one answer for the whole editor. The state field below exists so that a change
 * is a *transaction* the editor notices; it mirrors this value, it does not own
 * it.
 */
let projectMacros: MacroTable = NO_MACROS

/** The project's macros as they stand now. */
export const getProjectMacros = (): MacroTable => projectMacros

/**
 * Installs a table without a view, for a host that is about to build one.
 *
 * The macros have to be in place *before* the first description of the document,
 * or mathematics whose macros live in an `\input`ed file is typeset once with
 * them undefined — MathJax renders an unknown control sequence as its own name,
 * so that first render is wrong in a way nothing reports. The host calls this
 * immediately before creating the view, and `projectMacroUpdate` afterwards for
 * every change.
 */
export const setProjectMacros = (table: MacroTable): void => {
  projectMacros = table
}

/** Carries a new table into the state, so the editor sees the change. */
export const setProjectMacrosEffect = StateEffect.define<MacroTable>()

const projectMacrosConf = new Compartment()

/** The holder the compartment mounts; its value mirrors `projectMacros`. */
const macroTableField = (): Extension =>
  StateField.define<MacroTable>({
    create: () => projectMacros,
    update(value, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setProjectMacrosEffect)) return effect.value
      }
      return value
    },
  })

/**
 * Mounts the project macros on the editor.
 *
 * The starting value is whatever the host has already installed; a later update
 * arrives through `projectMacroUpdate`.
 */
export const projectMacrosExtension = (): Extension =>
  projectMacrosConf.of(macroTableField())

/**
 * Adopts a project macro table: everything typeset from now on sees it, and the
 * mathematics already on screen is re-typeset.
 *
 * Returns the transaction spec for the host to dispatch — the host owns the
 * view, and this module deliberately does not.
 */
export const projectMacroUpdate = (table: MacroTable): {
  /**
   * `StateEffect<unknown>` rather than `<MacroTable>` because the compartment
   * reconfiguration travels in the same list, and CodeMirror types that one
   * opaquely. It is a transaction spec, so nothing reads the effect values back.
   */
  effects: StateEffect<unknown>[]
} => {
  const changed = !sameMacroTable(projectMacros, table)
  projectMacros = table
  if (!changed) {
    // The index re-reads on every analysis of every open document, so most of
    // these carry the same table. Re-typesetting the whole document for one is
    // pure cost (Instructions.md §62), and the value is already installed.
    return { effects: [] }
  }
  return {
    effects: [
      setProjectMacrosEffect.of(table),
      projectMacrosConf.reconfigure(macroTableField()),
    ],
  }
}

/** Whether two tables define the same thing, definition for definition. */
const sameMacroTable = (a: MacroTable, b: MacroTable): boolean => {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(key => a[key] === b[key])
}

/**
 * True when one of these effects carries a new project macro table.
 *
 * Used from inside a `StateField.update`, where only the effects are in scope
 * (`atomic-decorations.ts`).
 */
export const effectsCarryProjectMacros = (
  effects: readonly StateEffect<unknown>[]
): boolean => effects.some(effect => effect.is(setProjectMacrosEffect))

/**
 * The TeX a typesetting call is given before the mathematics itself: the
 * project's macros, then whatever the caller collected from the document.
 *
 * The caller's definitions come **last** so the document in front of the user
 * wins: a `\newcommand` in the file being edited is the definition in force, even
 * if the project's macro file defines the same name.
 *
 * **TeX primitives are not passed through, and one of them matters a great deal.**
 * The macro collector reads `\let` as a definition — correctly, since a project
 * index wants to know that `\foo` exists — but its stored *definition* is the raw
 * statement, so `\let\cal\relax` in a macro file arrived at MathJax as the text
 * `\let\cal\relax`. MathJax has no `\let`; it cannot execute the primitive and it
 * cannot ignore it, so the reader got the command name in the error colour. On a
 * real topology paper, whose preamble says exactly that, `\cal` is used **38
 * times** and every one of them rendered as a red `\cal` followed by its argument.
 *
 * Dropping them is the honest fix rather than a translation: `\let` is used for
 * dozens of different jobs — aliasing, undefining, saving a macro before
 * redefining it, changing catcodes — and a translation that guessed would be wrong
 * silently. What is lost by dropping one is a definition MathJax could not have
 * used anyway; what is gained is that the mathematics around it renders.
 *
 * A definition that is *not* a primitive is passed through untouched, including
 * the `\newcommand` form: MathJax accepts `\newcommand`, `\def` and
 * `\DeclareMathOperator` alike.
 *
 * **The other two things a real preamble does that this has to survive** were both
 * found in one 297-line macro file (`macros.tex` of a topology paper), and both
 * fail silently in a different way:
 *
 *  * `\LetLtxMacro{\origforall}{\forall}` saves the original under a new name so a
 *    later `\renewcommand{\forall}{\origforall\,}` can add a space without
 *    recursing. The alias is a definition like any other and it *is* collected,
 *    but the statement that produces it is not one MathJax can read — so the saved
 *    original has to be rewritten to the `\def` that means the same thing before it
 *    is passed on. Miss that and `\forall` renders as a literal `\origforall` in
 *    the error colour, which is a font that is wrong rather than a command that
 *    failed;
 *  * `\renewcommand{\exists}{\exists\,}` — the same idiom with a typo in the saved
 *    name — expands to itself forever. MathJax refuses the whole expression rather
 *    than the one symbol. See `projectDefinitions`.
 */
export const composeMacroPreamble = (localDefinitions: string): string => {
  const entries = Object.entries(projectMacros)
  if (entries.length === 0) return localDefinitions
  /*
   * A saved original is resolved against *everything* that defines, not just the
   * project's own table. The command being copied is often the project's — the
   * paper's `\origexists` copies an `\exists` that `macros.tex` defines — and a
   * resolver that could only see the document's definitions would find nothing,
   * fall back to the name it is trying to look up, and rebuild the loop.
   */
  const merged: Array<[string, string]> = [...entries]
  const local = collectMacroDefinitions(
    parseLatexWithArguments(localDefinitions, {}).content,
    localDefinitions
  )
  for (const definition of local) merged.push([definition.name, definition.definition])
  const emitted = projectDefinitions(merged)
  const project = emitted.filter(definition => !isPrimitiveDefinition(definition)).join('\n')
  return localDefinitions
    ? project
      ? `${project}\n${localDefinitions}`
      : localDefinitions
    : project
}

/**
 * A macro name without its backslash.
 *
 * The stored table is not consistent about this — `\newcommand` definitions are
 * keyed bare (`exists`) and the primitives keep the backslash (`\let`) — so every
 * comparison between a name from a table and a name from a body goes through here.
 * Comparing two names that differ only by a backslash is how a lookup that should
 * have found the definition in front of it finds nothing and quietly rebuilds the
 * loop it was resolving.
 */
const bareName = (name: string): string => name.replace(/^\\/, '')

/**
 * The definitions to hand MathJax, in order, with the saved-original idiom read
 * the way LaTeX reads it.
 *
 * The idiom is `\LetLtxMacro{\origA}{\A}` followed later by
 * `\renewcommand{\A}{\origA\,}`: save the original, then redefine `\A` in terms
 * of the copy so the copy can be *added to* without recursing — here to put a
 * thin space after `\forall`. `\LetLtxMacro` is LaTeX's `\let`, and a `\let`
 * **freezes**: `\origA` means whatever `\A` meant at the moment it was saved.
 *
 * MathJax has no primitive that freezes. `\def`, `\let` and `\newcommand` all
 * expand at *use* time, so `\def\origforall{\forall}` followed by
 * `\renewcommand{\forall}{\origforall\,}` is an infinite loop whatever it is spelt
 * as, and MathJax answers it by refusing the entire expression — measured, for all
 * three spellings. There is therefore nothing to translate the idiom into.
 *
 * What is left is to read its *effect*: `\forall` is the symbol plus a thin space.
 * The symbol is the part that cannot be written down in advance, so it is kept by
 * dropping the redefinition and resolving the saved name to what `\A` was before —
 * which is MathJax's own built-in. What is lost is the thin space the author
 * wanted. What is gained is `\forall` itself, in the right face rather than as an
 * error box, and the guarantee that the other 230 definitions in the file still
 * reach the mathematics.
 *
 * Only a pair that genuinely closes a loop is touched: the saved original must be
 * named by the redefinition's body. `\renewcommand{\S}{\mathbb{S}}` and the other
 * five redefinitions in the same file define their commands outright and are
 * passed through untouched, because their bodies name their own command only in
 * the sense that `\S` is what is being defined.
 */
const projectDefinitions = (entries: Array<[string, string]>): string[] => {
  /** Saved-original name (bare) -> the command it was saved from (bare). */
  const savedFrom = new Map<string, string>()
  /** Saved-original name (bare) -> the index it was saved at. */
  const savedAt = new Map<string, number>()
  entries.forEach(([name, definition], index) => {
    const alias = /^\\def\\([a-zA-Z]+)\{\\([a-zA-Z]+)\}$/.exec(definition.trim())
    const saved = bareName(name)
    if (alias && !savedFrom.has(saved)) {
      savedFrom.set(saved, alias[2])
      savedAt.set(saved, index)
    }
  })

  /** Commands that a redefinition closes a loop through, and that redefinition. */
  const closedBy = new Map<string, string>()
  const selfCalls = new Set<string>()
  /**
   * Self-calls whose whole body is the command's own name, `\origexists` being the
   * pure case: the author meant to name a saved original and named the command
   * instead. Dropping the definition leaves MathJax's built-in in force, which is
   * the symbol the author was reaching for.
   */
  const emptyAliases = new Set<string>()
  entries.forEach(([name, definition]) => {
    const bare = bareName(name)
    const body = macroBody(definition)
    if (body === null) return
    const referenced = [...body.matchAll(/\\([a-zA-Z]+)/g)].map(match => match[1])
    /*
     * Only the redefinition half of a pair can be a self-call. The *alias* half's
     * body names a different command by construction, and the name the resolver
     * itself emits — `\def\A{}` — also names `\A`, so a check that ignored where a
     * definition came from would empty the very command it had just repaired.
     */
    const isAlias = savedFrom.get(bare) !== undefined
    if (!isAlias && referenced.includes(bare)) {
      selfCalls.add(bare)
      // Every control sequence removed and nothing left: `\exists\,`, `\exists`
      // and `\alpha` are all pure aliases. `\exists \land x` is not, and neither
      // is anything carrying text.
      if (body.replace(/\\[a-zA-Z]+|\\[^a-zA-Z]/g, '').trim() === '') emptyAliases.add(bare)
    }
    for (const reference of referenced) {
      if (savedFrom.get(bareName(reference)) === bare) closedBy.set(bare, definition)
    }
  })

  const emitted: string[] = []
  entries.forEach(([name, definition], index) => {
    const bare = bareName(name)
    if (closedBy.get(bare) === definition) return
    if (selfCalls.has(bare)) {
      /*
       * Two readings, and which one applies changes the output completely.
       *
       * A self-call whose body is *only* macro names — `\renewcommand{\exists}
       * {\exists\,}`, the typo — is a saved original that was never saved. There is
       * nothing to resolve and nothing to keep, and the useful answer is to leave
       * the command undefined so MathJax's own `\exists` shows through: the symbol
       * the author wanted, with the thin space lost exactly as it is for the pair
       * that resolves.
       *
       * Anything else names itself among other material, where dropping it would
       * take that material with it — so the name is bound to nothing at all and a
       * use of it contributes nothing.
       */
      if (!emptyAliases.has(bare)) emitted.push(`\\def\\${bare}{}`)
      return
    }
    const original = savedFrom.get(bare)
    // The saved name means whatever its command meant *at the moment it was
    // saved* — that is what a `\let` does. Reading the command's final definition
    // instead is the one mistake that reintroduces the loop the pair was written
    // to avoid, because the pair's second half is that final definition.
    if (original) {
      const inForce = definedAs(entries, original, savedAt.get(bare) ?? index)
      emitted.push(`\\def\\${bare}{${inForce ?? `\\${original}`}}`)
      return
    }
    emitted.push(definition)
  })
  return emitted
}

/**
 * The body `name` had at `before`, or `null` when nothing had defined it by then.
 *
 * `null` is the answer for a command MathJax itself supplies — `\forall`,
 * `\implies`, `\emptyset` are all built in, so a preamble that saves one of them
 * has nothing earlier in the file to point at and the name is left to MathJax.
 */
const definedAs = (
  entries: Array<[string, string]>,
  name: string,
  before: number
): string | null => {
  const wanted = bareName(name)
  let body: string | null = null
  entries.forEach(([entryName, definition], index) => {
    if (index >= before) return
    if (bareName(entryName) !== wanted) return
    const found = macroBody(definition)
    if (found !== null) body = found.trim()
  })
  return body
}

/**
 * The body of a macro definition, or `null` when it is not one this module can
 * read a body out of.
 *
 * A definition arrives in whichever spelling the author used, so the body is the
 * last brace-delimited group for `\newcommand`/`\renewcommand` and the first for
 * `\def`/`\let`. A `\LetLtxMacro` line has no body of its own and answering `null`
 * for it is correct: the collector has already rewritten it.
 */
const macroBody = (definition: string): string | null => {
  const trimmed = definition.trim()
  const renew = /^\\(?:re)?new(?:robust)?command\*?\s*(?:\{\s*\\[a-zA-Z]+\s*\}|\\[a-zA-Z]+)\s*(?:\[[^\]]*\])?\s*\{([\s\S]*)\}\s*$/.exec(trimmed)
  if (renew) return renew[1]
  const def = /^\\(?:def|edef|gdef|xdef)\s*\\[a-zA-Z]+\s*\{([\s\S]*)\}\s*$/.exec(trimmed)
  if (def) return def[1]
  return null
}

/** The primitives the macro collector records verbatim, none of which MathJax has. */
const PRIMITIVE_DEFINITIONS = ['\\let', '\\edef', '\\gdef', '\\xdef'] as const

/**
 * Whether a stored definition is a TeX primitive statement rather than a macro
 * body. `\def` is deliberately absent from the list: MathJax understands `\def`,
 * and a document may well use one.
 */
const isPrimitiveDefinition = (definition: string): boolean => {
  const trimmed = definition.trimStart()
  return PRIMITIVE_DEFINITIONS.some(primitive => trimmed.startsWith(primitive))
}
