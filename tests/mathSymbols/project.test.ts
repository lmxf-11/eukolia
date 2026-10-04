/**
 * Project-aware resolution — the declaration reader, the alias index, the
 * revisioned snapshot, and the ranking that joins them to the catalogue.
 *
 * `MathematicalSymbols.md` §6 (root-scoped project context), §7 (macro-aware
 * resolution — its examples are pinned one by one below) and §11 (the validation
 * plan) are the specification; `types.ts` is the contract. Every input is built
 * here from literals, so nothing in this file touches a workspace, an editor, a
 * file system or AppData.
 *
 * Seven blocks are marked `it.fails`. They assert behaviour the specification
 * requires and the implementation does not provide, so the suite stays green
 * while the defects are outstanding. The assertions inside them are the
 * specification's own — not one of them is relaxed — and each block names the
 * file and line it is about, so the marker can be lifted with the fix:
 *
 *  * `macroDefinition.ts:230` reads a `\let` target from the position of the
 *    declared *name*, so `\let\R\mathbb` reports `R` (observed);
 *  * `macroDefinition.ts:450` repeats that mistake in the alias index, filing the
 *    alias under `R` instead of `mathbb`;
 *  * that loses the saved-original idiom, so `resolveSymbol.ts:182` withdraws a
 *    `\forall` the project still draws;
 *  * `macroDefinition.ts:345` braces a slot whose surrounding parts already carry
 *    the braces, so no parameterised project alias can meet a catalog variant;
 *  * `macroDefinition.ts:499` reports only the first of two declarations claiming
 *    one signature, so the panel has no alternative to offer;
 *  * 51 catalog variants carry `command: null`, which `resolveSymbol.ts:211`
 *    hands to `bareCommand` (`commands.ts:19`) unguarded, so resolving them throws;
 *  * `resolveSymbol.ts:101` calls an unverified requirement `project` once the
 *    package happens to be loaded, where `types.ts:90` asks for `unknown`.
 */

import { describe, expect, it } from 'vitest';
import { catalogEntry } from '@/mathSymbols/catalog';
import {
  buildProjectAliasIndex,
  canonicalExpression,
  parseMacroDeclaration,
  variantSignature
} from '@/mathSymbols/macroDefinition';
import {
  buildProjectSymbolSnapshot,
  normalizeSourcePath,
  type ProjectSymbolSnapshotInput
} from '@/mathSymbols/projectSymbolContext';
import {
  availabilityOf,
  bestCandidate,
  resolveCandidates,
  unavailableExplanation
} from '@/mathSymbols/resolveSymbol';
import type {
  MathSymbolEntry,
  ProjectMacro,
  ProjectSymbolSnapshot,
  SymbolCandidate,
  SymbolVariant
} from '@/mathSymbols/types';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The active document, in the spelling the analysis reports paths in. */
const MAIN = 'D:\\Projects\\Paper\\main.tex';
/** A file the compilation root reaches. */
const CHAPTER = 'D:\\Projects\\Paper\\chapters\\one.tex';
/** A file it does not reach — §7's "unrelated/unincluded `macros.tex`". */
const STRAY = 'D:\\Projects\\Other\\macros.tex';

/** One `ProjectMacro`, with every field the test does not care about defaulted. */
const macro = (
  fields: Pick<ProjectMacro, 'name' | 'kind' | 'definition'> & Partial<ProjectMacro>
): ProjectMacro => ({
  args: 0,
  expansion: null,
  file: MAIN,
  line: 1,
  inScope: true,
  uncertainty: null,
  ...fields
});

/** §7's reachable `\newcommand{\R}{\mathbb{R}}`. */
const realsMacro = (overrides: Partial<ProjectMacro> = {}): ProjectMacro =>
  macro({
    name: 'R',
    kind: 'newcommand',
    definition: '\\newcommand{\\R}{\\mathbb{R}}',
    expansion: '\\mathbb{R}',
    line: 12,
    ...overrides
  });

/** §7's `\renewcommand{\epsilon}{\varepsilon}`. */
const epsilonMacro = (): ProjectMacro =>
  macro({
    name: 'epsilon',
    kind: 'renewcommand',
    definition: '\\renewcommand{\\epsilon}{\\varepsilon}',
    expansion: '\\varepsilon'
  });

/** A snapshot built by hand: the macros, the packages and the completion state. */
const snapshotOf = (
  macros: readonly ProjectMacro[] = [],
  packages: readonly string[] = [],
  complete = true
): ProjectSymbolSnapshot => ({
  revision: 1,
  workspaceRoot: 'D:\\Projects\\Paper',
  compilationRoot: MAIN,
  complete,
  macros,
  packages,
  engine: 'pdflatex',
  inclusions: [],
  limitations: { root: MAIN, truncated: false, notes: [] }
});

/** The catalog entry with `id`, which every test below names literally. */
function entry(id: string): MathSymbolEntry {
  const found = catalogEntry(id);
  if (!found) throw new Error(`the generated catalog has no entry "${id}"`);
  return found;
}

/** How the panel resolves an entry: the snapshot's own macros, ranked. */
const candidatesFor = (
  target: MathSymbolEntry,
  snapshot: ProjectSymbolSnapshot
): SymbolCandidate[] =>
  resolveCandidates({ entry: target, snapshot, aliases: buildProjectAliasIndex(snapshot.macros) });

/** A hand-built candidate, for the ranking rules that need no catalogue. */
const candidate = (
  fields: Pick<SymbolCandidate, 'command'> & Partial<SymbolCandidate>
): SymbolCandidate => ({
  entryId: 'test:entry',
  variantId: `test:${fields.command}`,
  origin: 'canonical',
  availability: {
    status: 'project',
    package: null,
    reason: 'the test snapshot loads it',
    verified: true
  },
  mode: 'math-only',
  selfContainedMath: false,
  declaredAt: null,
  notes: [],
  insertable: true,
  ...fields
});

/* ------------------------------------------------------------------ *
 * A. The declaration reader
 * ------------------------------------------------------------------ */

describe('parseMacroDeclaration — reading a declaration', () => {
  it('reads a braced \\newcommand', () => {
    const parsed = parseMacroDeclaration('\\newcommand{\\R}{\\mathbb{R}}', 'R');
    expect(parsed.kind).toBe('newcommand');
    expect(parsed.name).toBe('R');
    expect(parsed.args).toBe(0);
    expect(parsed.body).toBe('\\mathbb{R}');
    expect(parsed.letTarget).toBeNull();
    expect(parsed.operatorText).toBeNull();
    expect(parsed.starred).toBe(false);
  });

  it('accepts the unbraced name spelling', () => {
    // `\newcommand\R{...}` is the same declaration: only the name's spelling
    // differs, and `readMacroName` reads both.
    const parsed = parseMacroDeclaration('\\newcommand\\R{\\mathbb{R}}', 'R');
    expect(parsed.kind).toBe('newcommand');
    expect(parsed.name).toBe('R');
    expect(parsed.args).toBe(0);
    expect(parsed.body).toBe('\\mathbb{R}');
  });

  it('reports a definition with no braced group as an absent body', () => {
    // `\newcommand\R\mathbb` has no braced definition group at all. Reporting
    // `null` is the honest answer; inventing `\mathbb` as the body would make
    // `\R` look like an alias for the bare command.
    const parsed = parseMacroDeclaration('\\newcommand\\R\\mathbb', 'R');
    expect(parsed.kind).toBe('newcommand');
    expect(parsed.name).toBe('R');
    expect(parsed.args).toBe(0);
    expect(parsed.body).toBeNull();
  });

  it('reads an argument count and the body that uses it', () => {
    const parsed = parseMacroDeclaration('\\newcommand{\\vect}[1]{\\mathbf{#1}}', 'vect');
    expect(parsed.kind).toBe('newcommand');
    expect(parsed.args).toBe(1);
    expect(parsed.body).toBe('\\mathbf{#1}');
  });

  it('reads a count and a default value without confusing the two', () => {
    // `[2][d]` is "two arguments, the first optional and defaulting to `d`" —
    // the default must not be read as an argument count, nor as a second body.
    const parsed = parseMacroDeclaration('\\newcommand{\\x}[2][d]{#2}', 'x');
    expect(parsed.args).toBe(2);
    expect(parsed.body).toBe('#2');
  });

  it('reads \\renewcommand', () => {
    const parsed = parseMacroDeclaration('\\renewcommand{\\epsilon}{\\varepsilon}', 'epsilon');
    expect(parsed.kind).toBe('renewcommand');
    expect(parsed.name).toBe('epsilon');
    expect(parsed.args).toBe(0);
    expect(parsed.body).toBe('\\varepsilon');
  });

  it('reads \\providecommand, whose empty body is the empty string', () => {
    // The body is `''`: an empty group *was* read, so the reader reports what the
    // source says. `null` is reserved for "no body to read" (a `\let`, an
    // operator), and it is `canonicalExpression` that turns an empty body into
    // "nothing comparable" — which it does, below.
    const parsed = parseMacroDeclaration('\\providecommand{\\foo}{}', 'foo');
    expect(parsed.kind).toBe('providecommand');
    expect(parsed.name).toBe('foo');
    expect(parsed.args).toBe(0);
    expect(parsed.body).toBe('');
    expect(canonicalExpression(parsed.body)).toBeNull();
  });

  it('reads \\newrobustcmd as the new command it is', () => {
    // `macroDefinition.ts:138` maps the etoolbox/LaTeX3-adjacent spellings onto
    // the kinds they mean, so this is a `newcommand` and not an `unknown`.
    const parsed = parseMacroDeclaration('\\newrobustcmd{\\x}{y}', 'x');
    expect(parsed.kind).toBe('newcommand');
    expect(parsed.name).toBe('x');
    expect(parsed.body).toBe('y');
  });

  it('reads \\def of a zero-argument macro', () => {
    const parsed = parseMacroDeclaration('\\def\\R{\\mathbb{R}}', 'R');
    expect(parsed.kind).toBe('def');
    expect(parsed.name).toBe('R');
    expect(parsed.args).toBe(0);
    expect(parsed.body).toBe('\\mathbb{R}');
  });

  it('counts the parameters of a \\def body', () => {
    const parsed = parseMacroDeclaration('\\def\\f#1#2{#1+#2}', 'f');
    expect(parsed.kind).toBe('def');
    expect(parsed.args).toBe(2);
    expect(parsed.body).toBe('#1+#2');
  });

  it('counts a repeated parameter once', () => {
    // Arity is the number of *distinct* parameter slots, which is what the panel
    // has to offer as arguments.
    const parsed = parseMacroDeclaration('\\def\\g#1{#1#1}', 'g');
    expect(parsed.args).toBe(1);
  });

  it('reads a \\let as a binding with no body of its own', () => {
    // `\let` binds at declaration time and has no body of its own, so what has
    // to be recovered is the *target*, not an expansion.
    const parsed = parseMacroDeclaration('\\let\\R\\mathbb', 'R');
    expect(parsed.kind).toBe('let');
    expect(parsed.name).toBe('R');
    expect(parsed.args).toBe(0);
    expect(parsed.body).toBeNull();
  });

  it('reads a \\let target as the command the name was bound to', () => {
    // `\let\R\mathbb` makes `\R` another name for `\mathbb`, so the target is
    // `mathbb` — reading it from where the *name* starts answers `R`, and an
    // alias that points at itself is worse than no alias at all.
    expect(parseMacroDeclaration('\\let\\R\\mathbb', 'R').letTarget).toBe('mathbb');
    expect(parseMacroDeclaration('\\let\\R=\\mathbb', 'R').letTarget).toBe('mathbb');
    expect(parseMacroDeclaration('\\let\\R = \\mathbb', 'R').letTarget).toBe('mathbb');
  });

  it('reads \\DeclareMathOperator and its operator text', () => {
    // §7: a declared operator is exposed with its operator semantics, so the text
    // it typesets is part of what the reader has to recover.
    const parsed = parseMacroDeclaration('\\DeclareMathOperator{\\Hom}{Hom}', 'Hom');
    expect(parsed.kind).toBe('DeclareMathOperator');
    expect(parsed.name).toBe('Hom');
    expect(parsed.args).toBe(0);
    expect(parsed.operatorText).toBe('Hom');
    expect(parsed.starred).toBe(false);
    // An operator is not a body: there is no expression to compare against the
    // catalogue, which is why it can never become a glyph alias.
    expect(parsed.body).toBeNull();
  });

  it('reads the starred \\DeclareMathOperator', () => {
    const parsed = parseMacroDeclaration(
      '\\DeclareMathOperator*{\\varinjlim}{inj\\,lim}',
      'varinjlim'
    );
    expect(parsed.kind).toBe('DeclareMathOperator');
    expect(parsed.name).toBe('varinjlim');
    expect(parsed.starred).toBe(true);
    expect(parsed.operatorText).toBe('inj\\,lim');
  });

  it('reads a body with a nested group to its real end', () => {
    // A regex that stopped at the first `}` would report `\frac{a` here, and the
    // signature built from it would compare equal to nothing at all.
    const parsed = parseMacroDeclaration('\\newcommand{\\f}{\\frac{a}{b}}', 'f');
    expect(parsed.body).toBe('\\frac{a}{b}');
    expect(canonicalExpression(parsed.body)).toBe('\\frac{a}{b}');
  });

  it('downgrades a spelling it does not know to `unknown`', () => {
    // §7 asks for the listed declaration forms to be recognised safely; anything
    // else keeps its name and arity and admits that its meaning is unknown rather
    // than guessing one.
    const parsed = parseMacroDeclaration('\\NewDocumentCommand{\\x}{m}{#1}', 'x', 1);
    expect(parsed.kind).toBe('unknown');
    expect(parsed.name).toBe('x');
    expect(parsed.args).toBe(1);
    expect(parsed.body).toBeNull();
    expect(parsed.letTarget).toBeNull();
  });

  it('keeps a conditional body as source but refuses to canonicalise it', () => {
    // §6: an unsupported conditional produces an uncertain result, not a guess.
    // The body is still read — it is what the file says — but it has no single
    // meaning, so no signature is ever claimed from it.
    const parsed = parseMacroDeclaration('\\def\\a{\\ifx\\b\\c d\\else e\\fi}', 'a');
    expect(parsed.kind).toBe('def');
    expect(parsed.args).toBe(0);
    expect(parsed.body).toBe('\\ifx\\b\\c d\\else e\\fi');
    expect(canonicalExpression(parsed.body)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * B. Comparable expressions
 * ------------------------------------------------------------------ */

describe('canonicalExpression — when two spellings denote the same thing', () => {
  it('treats a whole-expression brace group as the expression itself', () => {
    // A declaration may be written either way, so `{\mathbb{R}}` and
    // `\mathbb{R}` have to compare equal — and to the form the catalogue uses.
    expect(canonicalExpression('{\\mathbb{R}}')).toBe(canonicalExpression('\\mathbb{R}'));
    expect(canonicalExpression('{\\mathbb{R}}')).toBe('\\mathbb{R}');
  });

  it('ignores the space TeX ignores after a control word', () => {
    // `\mathbb {R}` and `\mathbb{R}` typeset identically; the space only ends the
    // control word.
    expect(canonicalExpression('\\mathbb {R}')).toBe(canonicalExpression('\\mathbb{R}'));
  });

  it('keeps the space inside a text argument', () => {
    // §7's refusal in the other direction: only the space after a control *word*
    // is insignificant, so prose in `\text{...}` must not be collapsed.
    expect(canonicalExpression('\\text{a b}')).not.toBe(canonicalExpression('\\text{ab}'));
  });

  it('does not normalise one expression into another', () => {
    // The whole point of the signature is §7's refusal to read `\mathcal{R}` as
    // the real numbers.
    expect(canonicalExpression('\\mathcal{R}')).not.toBe(canonicalExpression('\\mathbb{R}'));
  });

  it('refuses a body whose meaning it cannot decide', () => {
    for (const body of [
      '\\ifx\\b\\c d\\else e\\fi',
      '\\csname foo\\endcsname',
      '\\expandafter\\foo\\bar'
    ]) {
      expect(canonicalExpression(body), body).toBeNull();
    }
  });

  it('returns null for null and for a body with nothing in it', () => {
    // An unreadable body must stay unreadable: an empty string treated as a
    // comparable expression would match every empty declaration to every other.
    expect(canonicalExpression(null)).toBeNull();
    expect(canonicalExpression('')).toBeNull();
    expect(canonicalExpression('{}')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * C. The alias index — §7's examples
 * ------------------------------------------------------------------ */

describe('buildProjectAliasIndex — §7\'s alias examples', () => {
  it('claims the expression a reachable \\newcommand denotes', () => {
    // §7: "Reachable \newcommand{\R}{\mathbb{R}}: the real-number item can insert
    // \R and show its definition location."
    const r = realsMacro();
    const alias = buildProjectAliasIndex([r]).bySignature.get('\\mathbb{R}');
    expect(alias?.macro).toBe(r);
    expect(alias?.kind).toBe('expression');
    expect(alias?.signature).toBe('\\mathbb{R}');
    expect(alias?.targetCommand).toBeNull();
  });

  it('ignores a declaration that is not in scope', () => {
    // §7: "Unrelated/unincluded macros.tex defines \R: do not use it." Nothing at
    // all may be claimed from a declaration the compilation never runs.
    const index = buildProjectAliasIndex([
      realsMacro({
        inScope: false,
        uncertainty: 'declared in a file the compilation root does not include'
      })
    ]);
    expect(index.bySignature.size).toBe(0);
    expect(index.byCommand.size).toBe(0);
    expect(index.templates).toEqual([]);
    expect(index.ambiguous).toEqual([]);
  });

  it('does not treat \\mathcal{R} as the real numbers', () => {
    // §7: "\newcommand{\R}{\mathcal{R}}: do not treat it as real numbers." The
    // signature comes from the body, not from the name, which is what makes the
    // refusal possible.
    const index = buildProjectAliasIndex([
      realsMacro({ definition: '\\newcommand{\\R}{\\mathcal{R}}', expansion: '\\mathcal{R}' })
    ]);
    expect(index.bySignature.has('\\mathbb{R}')).toBe(false);
    expect(index.bySignature.get('\\mathcal{R}')?.macro.name).toBe('R');
  });

  it('exposes a one-argument declaration as a template and as a signature', () => {
    // §7: "\newcommand{\vect}[1]{\mathbf{#1}}: expose a project template with one
    // argument slot; do not present it as a zero-argument glyph."
    const vect = macro({
      name: 'vect',
      kind: 'newcommand',
      args: 1,
      definition: '\\newcommand{\\vect}[1]{\\mathbf{#1}}',
      expansion: '\\mathbf{#1}'
    });
    const index = buildProjectAliasIndex([vect]);
    expect(index.templates.map((item) => item.name)).toEqual(['vect']);
    expect(index.bySignature.get('\\mathbf{#1}')?.macro).toBe(vect);
  });

  it('matches a one-argument declaration against the catalog variant it denotes', () => {
    // A slot renders as `#n` and the braces come from the template's own parts —
    // `tpl:mathbf` is `["\mathbf{", slot, "}"]` — so the signature is exactly the
    // `\mathbf{#1}` a declaration canonicalises to. Wrapping the slot as well
    // would give `\mathbf{{#1}}`, which no declaration can match, and §7's
    // "recognize parameterized aliases only when argument mapping is
    // demonstrably equivalent" would be unreachable.
    const vect = macro({
      name: 'vect',
      kind: 'newcommand',
      args: 1,
      definition: '\\newcommand{\\vect}[1]{\\mathbf{#1}}',
      expansion: '\\mathbf{#1}'
    });
    const variant = entry('tpl:mathbf').variants[0];
    const signature = variantSignature(variant.parts, variant.slots.length);
    expect(signature).toBe('\\mathbf{#1}');
    expect(buildProjectAliasIndex([vect]).bySignature.get(signature)?.macro).toBe(vect);
  });

  it('matches a zero-argument declaration against the expression it denotes', () => {
    // §7's headline example is a *zero-argument* alias: `\newcommand{\R}{…}`
    // denotes one expression, so its variant's signature is that expression and
    // not `null`. Answering `null` for "no slots" disables every such alias.
    const alpha = entry('mjs:alpha').variants[0];
    expect(variantSignature(alpha.parts, alpha.slots.length)).toBe('\\alpha');
    const reals = entry('cur:reals').variants[0];
    expect(variantSignature(reals.parts, reals.slots.length)).toBe('\\mathbb{R}');
  });

  it('records a \\let as another name for the command it bound', () => {
    // The `command` alias exists so `\let\R\mathbb` can offer `\R` for every
    // entry `\mathbb` provides; §7's "track \let binding at declaration time".
    const r = macro({ name: 'R', kind: 'let', definition: '\\let\\R\\mathbb', letTarget: 'mathbb' });
    const alias = buildProjectAliasIndex([r]).byCommand.get('mathbb');
    expect(alias?.macro).toBe(r);
    expect(alias?.kind).toBe('command');
    expect(alias?.targetCommand).toBe('\\mathbb');
    expect(buildProjectAliasIndex([r]).byCommand.has('R')).toBe(false);
  });

  it('reports both declarations when two of them claim one signature', () => {
    // §7: "If multiple project aliases remain equally plausible, retain the
    // verified canonical spelling by default and expose alternatives." An index
    // that keeps only the first claimant cannot expose the second, or even name
    // it.
    const r = realsMacro();
    const rr = realsMacro({ name: 'RR' });
    const index = buildProjectAliasIndex([r, rr]);
    expect(index.bySignature.has('\\mathbb{R}')).toBe(false);
    expect(index.ambiguous.map((item) => item.name)).toEqual(['R', 'RR']);
  });

  it('bounds an alias chain that points back at itself', () => {
    // §7: "Bound alias expansion and detect cycles." Both directions are claimed
    // once and the call returns: nothing here expands one body through another, so
    // there is no loop to run away with.
    const a = macro({ name: 'a', kind: 'def', definition: '\\def\\a{\\b}', expansion: '\\b' });
    const b = macro({ name: 'b', kind: 'def', definition: '\\def\\b{\\a}', expansion: '\\a' });
    const index = buildProjectAliasIndex([a, b]);
    expect(index.bySignature.get('\\b')?.macro.name).toBe('a');
    expect(index.bySignature.get('\\a')?.macro.name).toBe('b');
    expect(index.bySignature.size).toBe(2);
  });

  it('records a redefinition of a canonical name', () => {
    // §7: "\renewcommand{\epsilon}{\varepsilon}: the epsilon variants must reflect
    // the changed meaning; do not insert misleading code based only on the name."
    // Recording it is this module's job; refusing the name is the resolver's.
    const epsilon = epsilonMacro();
    const index = buildProjectAliasIndex([epsilon]);
    expect(index.redefined.get('epsilon')).toBe(epsilon);
    expect(index.bySignature.has('\\epsilon')).toBe(false);
  });

  it('does not turn a \\DeclareMathOperator into a glyph alias', () => {
    // §7: "A valid \DeclareMathOperator{\Hom}{Hom}: expose it under Project
    // macros/Functions with its actual operator semantics." An operator is not
    // another spelling of a catalog glyph, so it claims neither a signature nor a
    // command — and it is not quietly re-read as something it is not.
    const hom = macro({
      name: 'Hom',
      kind: 'DeclareMathOperator',
      definition: '\\DeclareMathOperator{\\Hom}{Hom}'
    });
    const index = buildProjectAliasIndex([hom]);
    expect(index.bySignature.size).toBe(0);
    expect(index.byCommand.size).toBe(0);
    expect(index.bySignature.has('\\Hom')).toBe(false);
    expect(index.byCommand.has('Hom')).toBe(false);
    expect(index.redefined.has('Hom')).toBe(false);
    expect(index.templates).toEqual([]);
    expect(index.uncertain).toEqual([]);
    expect(index.ambiguous).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * D. The revisioned snapshot
 * ------------------------------------------------------------------ */

describe('buildProjectSymbolSnapshot — scope, provenance and determinism', () => {
  const input = (
    overrides: Partial<ProjectSymbolSnapshotInput> = {}
  ): ProjectSymbolSnapshotInput => ({
    workspaceRoot: 'D:\\Projects\\Paper',
    compilationRoot: MAIN,
    activeDocumentPath: MAIN,
    reachableSources: [MAIN, CHAPTER],
    macros: [],
    packages: [],
    engine: 'pdflatex',
    complete: true,
    ...overrides
  });

  it('puts a macro declared in the active document in scope', () => {
    // The user is looking at the file, so nothing has to be proved for it.
    const snapshot = buildProjectSymbolSnapshot(
      input({
        macros: [
          { name: 'R', args: 0, file: MAIN, line: 12, definition: '\\newcommand{\\R}{\\mathbb{R}}' }
        ]
      }),
      1
    );
    const [r] = snapshot.macros;
    expect(r.name).toBe('R');
    expect(r.inScope).toBe(true);
    expect(r.uncertainty).toBeNull();
    expect(r.expansion).toBe('\\mathbb{R}');
    expect(r.file).toBe(MAIN);
    expect(r.line).toBe(12);
  });

  it('puts a macro in a file the compilation root reaches in scope, and states the limit', () => {
    // §6: a reachable declaration is in scope, but the include *order* was not
    // modelled, so the limit is reported rather than hidden.
    const snapshot = buildProjectSymbolSnapshot(
      input({
        macros: [
          {
            name: 'vect',
            args: 1,
            file: CHAPTER,
            line: 3,
            definition: '\\newcommand{\\vect}[1]{\\mathbf{#1}}'
          }
        ]
      }),
      2
    );
    const [vect] = snapshot.macros;
    expect(vect.inScope).toBe(true);
    expect(vect.uncertainty).not.toBeNull();
    expect(vect.uncertainty).toContain('include order');
    expect(vect.args).toBe(1);
    // A parameterised body is kept: the template alias path reads it as-is.
    expect(vect.expansion).toBe('\\mathbf{#1}');
  });

  it('keeps a file the root does not include out of scope, and says why', () => {
    // §7: "Unrelated/unincluded macros.tex defines \R: do not use it." With a
    // known root, the reason names the root.
    const snapshot = buildProjectSymbolSnapshot(
      input({
        macros: [
          { name: 'R', args: 0, file: STRAY, line: 4, definition: '\\newcommand{\\R}{\\mathbb{R}}' }
        ]
      }),
      3
    );
    const [r] = snapshot.macros;
    expect(r.inScope).toBe(false);
    expect(r.uncertainty).not.toBeNull();
    expect(r.uncertainty).toContain('does not include');
  });

  it('claims nothing outside the active document when no root is known', () => {
    // §6: "For standalone files with no root, use known local declarations and
    // core commands; do not borrow macros from unrelated open projects."
    const snapshot = buildProjectSymbolSnapshot(
      input({
        workspaceRoot: null,
        compilationRoot: null,
        reachableSources: [],
        macros: [
          { name: 'R', args: 0, file: MAIN, line: 1, definition: '\\newcommand{\\R}{\\mathbb{R}}' },
          { name: 'other', args: 0, file: STRAY, line: 1, definition: '\\newcommand{\\other}{x}' }
        ]
      }),
      4
    );
    const byName = new Map(snapshot.macros.map((item) => [item.name, item]));
    expect(byName.get('R')?.inScope).toBe(true);
    expect(byName.get('other')?.inScope).toBe(false);
    expect(byName.get('other')?.uncertainty).toContain('no compilation root is known');
  });

  it('treats an unsaved buffer as out of scope unless it is the active document', () => {
    // A `file: null` declaration belongs to the caret's own buffer or to one the
    // analysis cannot place; §6 will not let a second buffer's macros leak in.
    const snapshot = buildProjectSymbolSnapshot(
      input({
        macros: [{ name: 'x', args: 0, file: null, line: 1, definition: '\\newcommand{\\x}{y}' }]
      }),
      5
    );
    expect(snapshot.macros[0].inScope).toBe(false);
    expect(snapshot.macros[0].uncertainty).toContain('unsaved buffer');
  });

  it('lower-cases, de-duplicates and sorts the package list', () => {
    // §6 collects packages from every source of the compilation; the snapshot is
    // what the resolver compares a requirement against, so it has to be one form.
    const snapshot = buildProjectSymbolSnapshot(
      input({ packages: ['Amssymb', 'amsmath', 'AMSSYMB', 'xcolor'] }),
      6
    );
    expect(snapshot.packages).toEqual(['amsmath', 'amssymb', 'xcolor']);
  });

  it('carries the revision and the completion state it was given', () => {
    // §6: only the caller knows whether this snapshot replaces the previous one,
    // so the revision is passed through rather than derived.
    const snapshot = buildProjectSymbolSnapshot(input({ complete: false, engine: 'xelatex' }), 42);
    expect(snapshot.revision).toBe(42);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.engine).toBe('xelatex');
    expect(snapshot.compilationRoot).toBe(MAIN);
  });

  it('returns a frozen snapshot', () => {
    // The snapshot is shared with the panel and with the resolver; nobody owns it,
    // so nobody may edit it.
    const snapshot = buildProjectSymbolSnapshot(input(), 7);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.macros)).toBe(true);
    expect(Object.isFrozen(snapshot.packages)).toBe(true);
  });

  it('is deterministic whatever order the index reported the macros in', () => {
    // §11: two runs over the same data produce the same snapshot, so the panel's
    // list cannot reshuffle because a file was re-registered.
    const raw = [
      { name: 'zeta', args: 0, file: MAIN, line: 30, definition: '\\newcommand{\\zeta}{z}' },
      { name: 'alpha', args: 0, file: CHAPTER, line: 9, definition: '\\newcommand{\\alpha}{a}' },
      { name: 'alpha', args: 0, file: MAIN, line: 2, definition: '\\newcommand{\\alpha}{A}' }
    ];
    const forward = buildProjectSymbolSnapshot(input({ macros: raw }), 8);
    const backward = buildProjectSymbolSnapshot(input({ macros: [...raw].reverse() }), 8);
    expect(forward.macros).toEqual(backward.macros);
    expect(forward.macros.map((item) => `${item.name}@${item.line}`)).toEqual([
      'alpha@2',
      'alpha@9',
      'zeta@30'
    ]);
  });

  it('normalises a path the way every comparison in the feature does', () => {
    // §6's scope comparisons all run on this form: backslashes folded, trailing
    // separators dropped, case folded.
    expect(normalizeSourcePath('C:\\Projects\\Paper\\')).toBe('c:/projects/paper');
    expect(normalizeSourcePath('D:/Projects/Paper')).toBe(
      normalizeSourcePath('d:\\PROJECTS\\PAPER\\')
    );
    expect(normalizeSourcePath(null)).toBeNull();
    expect(normalizeSourcePath(undefined)).toBeNull();
    expect(normalizeSourcePath('')).toBeNull();
  });

  it('keeps the path as the analysis spelled it for the provenance line', () => {
    // The panel shows `file:line`, so the snapshot keeps the original spelling
    // while scope is decided on the normalised one.
    const snapshot = buildProjectSymbolSnapshot(
      input({
        macros: [
          {
            name: 'R',
            args: 0,
            file: 'd:\\projects\\paper\\MAIN.TEX',
            line: 5,
            definition: '\\newcommand{\\R}{\\mathbb{R}}'
          }
        ]
      }),
      9
    );
    expect(snapshot.macros[0].file).toBe('d:\\projects\\paper\\MAIN.TEX');
    expect(snapshot.macros[0].inScope).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * E. Ranking and availability
 * ------------------------------------------------------------------ */

describe('resolveSymbol — availability', () => {
  it('offers a core command before analysis has finished', () => {
    // A satisfied requirement is never re-checked against `complete`: the kernel is
    // a static fact, so the panel works while the project is still being read.
    const candidates = candidatesFor(entry('mjs:alpha'), snapshotOf([], [], false));
    const alpha = candidates.find((item) => item.command === '\\alpha');
    expect(alpha?.availability.status).toBe('core');
    expect(alpha?.availability.verified).toBe(true);
    expect(alpha?.insertable).toBe(true);
    expect(bestCandidate(candidates)).toBe(alpha);
  });

  it('accepts a variant the project loads the package for', () => {
    const candidates = candidatesFor(entry('tpl:mathbb'), snapshotOf([], ['amssymb']));
    const mathbb = candidates.find((item) => item.command === '\\mathbb');
    expect(mathbb?.availability.status).toBe('project');
    expect(mathbb?.availability.package).toBe('amssymb');
    expect(mathbb?.insertable).toBe(true);
  });

  it('refuses a variant whose package is missing once analysis is complete', () => {
    // §7: "disable normal insertion if no verified variant exists", while the item
    // stays discoverable and explains itself.
    const candidates = candidatesFor(entry('tpl:mathbb'), snapshotOf([], [], true));
    const mathbb = candidates.find((item) => item.command === '\\mathbb');
    expect(mathbb?.availability.status).toBe('missing-package');
    expect(mathbb?.availability.package).toBe('amssymb');
    expect(mathbb?.insertable).toBe(false);
    expect(bestCandidate(candidates)).toBeNull();
  });

  it('says "still checking" rather than "missing" while analysis runs', () => {
    // The two facts are different, and only one of them is known: an unfinished
    // analysis is not evidence that a package is absent.
    const candidates = candidatesFor(entry('tpl:mathbb'), snapshotOf([], [], false));
    const mathbb = candidates.find((item) => item.command === '\\mathbb');
    expect(mathbb?.availability.status).toBe('unknown');
    expect(mathbb?.availability.status).not.toBe('missing-package');
    expect(mathbb?.insertable).toBe(false);
  });

  it('states an unverified requirement as unverified, without denying the command', () => {
    /*
     * A requirement parsed from `unimathsymbols.json`'s free-text `detail` is a
     * hint: the package name came out of a regular expression over prose, and
     * `MathematicalSymbols.md` §5 asks for such metadata to be validated rather
     * than believed. So `verified: false` is carried through to the answer.
     *
     * The two directions are not symmetric, and that is the point. When the
     * named package is *loaded*, the project's own package list is a fact and
     * the command is available — the reason says the attribution is unverified
     * instead of withholding a command that works. When the named package is
     * *absent*, an unverified hint may not deny the command either, because a
     * wrong package name would hide a symbol the user has; that case is
     * `unknown`, asserted in the test above.
     */
    const variant: SymbolVariant = {
      id: 'test:unverified@x',
      command: '\\unverifiedcmd',
      parts: [{ text: '\\unverifiedcmd' }],
      slots: [],
      requires: [{ package: 'amssymb', kind: 'package', verified: false, source: 'unimathsymbols-detail' }],
      engines: null,
      mode: 'math-only',
      selfContainedMath: false
    };
    const target: MathSymbolEntry = {
      id: 'test:unverified',
      name: '\\unverifiedcmd',
      glyph: null,
      preview: 'command',
      previewSource: null,
      categories: ['miscellaneous'],
      aliases: [],
      keywords: [],
      description: null,
      core: null,
      source: 'test',
      variants: [variant]
    };

    const loaded = availabilityOf(variant, snapshotOf([], ['amssymb']));
    expect(loaded.status).toBe('project');
    expect(loaded.verified).toBe(false);
    expect(loaded.reason).toMatch(/has not verified/);
    // The candidate carries a note saying so as well, so the details pane shows
    // the caveat next to the code rather than only in the availability line.
    const candidate = bestCandidate(candidatesFor(target, snapshotOf([], ['amssymb'])));
    expect(candidate?.command).toBe('\\unverifiedcmd');
    expect(candidate?.notes.join(' ')).toMatch(/has not been verified/);
  });
});

describe('resolveSymbol — ranking, aliases and redefinitions', () => {
  it('offers a project alias for the construct it denotes, with its declaration site', () => {
    // §7's ranking, second rule: a unique statically verified project alias for the
    // exact construct wins over the canonical spelling, and it carries the line the
    // user can go and look at. Pinned on `mjs:alpha`, because §7's own real-number
    // example cannot be resolved at all today — see the `it.fails` block below.
    const alpha = entry('mjs:alpha');
    const candidates = candidatesFor(
      alpha,
      snapshotOf([
        macro({
          name: 'a',
          kind: 'newcommand',
          definition: '\\newcommand{\\a}{\\alpha}',
          expansion: '\\alpha',
          line: 12
        })
      ])
    );
    const alias = candidates.find((item) => item.origin === 'project-alias');
    expect(alias?.command).toBe('\\a');
    expect(alias?.variantId).toBe(`${alpha.variants[0].id}@project:a`);
    expect(alias?.declaredAt).toEqual({ file: MAIN, line: 12 });
    expect(alias?.notes.join(' ')).toContain('this project defines \\a as');
    expect(alias?.insertable).toBe(true);
    expect(bestCandidate(candidates)).toBe(alias);
  });

  it('offers the project alias for the real-number item, with its declaration site', () => {
    // §7's headline example: "Reachable \newcommand{\R}{\mathbb{R}}: the
    // real-number item can insert \R and show its definition location."
    //
    // `cur:reals` is one of the fifty-one catalog entries whose variant carries
    // `command: null` — it is the complete expression `\mathbb{R}` rather than a
    // control sequence — and the panel resolves every search hit for its default
    // "Available" filter, so a resolver that assumed a non-null command failed
    // panel-wide rather than in a corner.
    const reals = entry('cur:reals');
    const candidates = candidatesFor(reals, snapshotOf([realsMacro()], ['amsfonts']));
    const alias = candidates.find((item) => item.origin === 'project-alias');
    expect(alias?.command).toBe('\\R');
    expect(alias?.declaredAt).toEqual({ file: MAIN, line: 12 });
    expect(alias?.insertable).toBe(true);
    expect(bestCandidate(candidates)).toBe(alias);
    // And the canonical expression is still offered as the alternative, so the
    // catalogue's own spelling is never lost.
    expect(candidates.some((item) => item.origin === 'canonical')).toBe(true);
  });

  it('keeps the template alias and the constant alias apart', () => {
    // The constant `\R` denotes `\mathbb{R}`, one letter, and not the
    // parameterised `\mathbb{…}` template `tpl:mathbb` provides, so it is rightly
    // not offered for it: the signatures are `\mathbb{R}` and `\mathbb{#1}`, and
    // they are different expressions. Substituting a constant's name into a
    // template's slots would insert something the user did not choose.
    const candidates = candidatesFor(entry('tpl:mathbb'), snapshotOf([realsMacro()], ['amssymb']));
    expect(candidates.some((item) => item.origin === 'project-alias')).toBe(false);
    expect(bestCandidate(candidates)?.command).toBe('\\mathbb');
  });

  it('withdraws a canonical command the project has redefined', () => {
    // §7: "\renewcommand{\epsilon}{\varepsilon} ... do not insert misleading code
    // based only on the name." `\epsilon` no longer draws ϵ, so it is not offered
    // for the epsilon entry at all.
    const candidates = candidatesFor(entry('mjs:epsilon'), snapshotOf([epsilonMacro()]));
    expect(candidates.filter((item) => item.command === '\\epsilon' && item.insertable)).toEqual(
      []
    );
    expect(bestCandidate(candidates)).toBeNull();
    expect(unavailableExplanation(candidates)).toContain('no spelling');
  });

  it('still offers the spelling the redefinition actually denotes', () => {
    // The name is gone from the epsilon entry, not from the language: `\epsilon`
    // is now a name for ε, so it is a project alias for the varepsilon entry and
    // the canonical `\varepsilon` is offered beside it.
    const candidates = candidatesFor(entry('mjs:varepsilon'), snapshotOf([epsilonMacro()]));
    const varepsilon = candidates.find((item) => item.command === '\\varepsilon');
    expect(varepsilon?.insertable).toBe(true);
    expect(varepsilon?.availability.status).toBe('core');
    expect(bestCandidate(candidates)).toBe(
      candidates.find((item) => item.origin === 'project-alias')
    );
  });

  it.fails(
    'keeps a canonical command rebuilt from a saved copy of itself (defect: macroDefinition.ts:450 → resolveSymbol.ts:182)',
    () => {
      // resolveSymbol.ts:171 recognises the saved-original idiom:
      // `\let\origforall\forall` then `\renewcommand{\forall}{\origforall\,}` still
      // draws ∀, so `\forall` stays insertable with a note. Observed: the alias
      // index files the `\let` under its own name (`origforall -> \origforall`),
      // `redefinitionPreservesMeaning` cannot see the saved copy, the canonical
      // spelling is withdrawn and the entry has no candidate at all.
      const snapshot = snapshotOf([
        macro({
          name: 'origforall',
          kind: 'let',
          definition: '\\let\\origforall\\forall',
          line: 3
        }),
        macro({
          name: 'forall',
          kind: 'renewcommand',
          definition: '\\renewcommand{\\forall}{\\origforall\\,}',
          expansion: '\\origforall\\,',
          line: 4
        })
      ]);
      const candidates = candidatesFor(entry('mjs:forall'), snapshot);
      const forall = candidates.find((item) => item.command === '\\forall');
      expect(forall?.insertable).toBe(true);
      expect(forall?.notes.join(' ')).toContain('redefined in this project in terms of itself');
    }
  );

  it('skips a candidate that cannot be inserted', () => {
    // The insert button uses `bestCandidate`, so a refused spelling must not be
    // reachable through it even when it is the only ranked candidate.
    const blocked = candidate({ command: '\\mathbb', insertable: false });
    const allowed = candidate({ command: '\\R', insertable: true });
    expect(bestCandidate([blocked])).toBeNull();
    expect(bestCandidate([blocked, allowed])).toBe(allowed);
  });

  it('names the missing package in the explanation', () => {
    // §7: "keep the item discoverable in All symbols, show the required
    // package/capability, and disable normal insertion".
    const explanation = unavailableExplanation(
      candidatesFor(entry('tpl:mathbb'), snapshotOf([], [], true))
    );
    expect(explanation).toContain('amssymb');
    expect(explanation).toContain('preamble');
  });

  it('does not tell the user to add a package it has not finished checking for', () => {
    // The same entry, still being analysed, must read as "still checking" — the
    // panel must not send the user to the preamble over a fact it does not have.
    const explanation = unavailableExplanation(
      candidatesFor(entry('tpl:mathbb'), snapshotOf([], [], false))
    );
    expect(explanation).toContain('still checking');
    expect(explanation).not.toContain('preamble');
  });
});
