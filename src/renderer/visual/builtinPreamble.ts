/**
 * The TeX definitions Eukolia gives MathJax before it typesets anything.
 *
 * Everything here exists because of a measured failure, not a guess. Each was
 * typeset through the local MathJax 4 first, and each produced `Unknown
 * environment …` error markup — which is what a reader sees as a red box where a
 * proof or a theorem should be:
 *
 *   | input | MathJax's answer |
 *   |---|---|
 *   | `\begin{proof}…\end{proof}` | `Unknown environment 'proof'` |
 *   | `\newtheorem{definition}{Definition}` then `\begin{definition}` | `Unknown environment 'definition'` |
 *   | `\begin{tikzcd}…\end{tikzcd}` | `Unknown environment 'tikzcd'` |
 *
 * **`\newtheorem` does not define anything in MathJax.** That is the fact the
 * fourth report rests on, and it is worth stating plainly because the port looks
 * like it handles it: `atomic-decorations.ts` parses `\newtheorem` for the
 * editor's *own* environments — the header it draws, the name it shows — and
 * MathJax never learns the environment exists. A document whose theorem
 * environments are declared the ordinary way therefore renders every one of them
 * as an error, however well the editor decorates the `\begin`.
 *
 * So the environments are declared here, as plain `\def`s, for the names a
 * mathematical document uses without declaring them (LaTeX's own `proof` and the
 * `amsthm` theorem family). A document that declares its own gets both: its name
 * is used by the editor's header, and the rendered body uses these.
 *
 * The definitions are deliberately plain — the environment's name in bold, then
 * its body. They are a *fallback*, so that mathematics inside a theorem is
 * typeset as mathematics rather than swallowed by an error box. The body is what
 * carries the meaning; the label is there so the reader can see which
 * environment they are in.
 *
 * `\qedhere` gets the same treatment. MathJax does not error on it — it prints
 * the name, which is the worse failure, because a reader sees "qedhere" trailing
 * a proof and nothing says anything is wrong.
 */

/**
 * The names a document may use without declaring them.
 *
 * `proof` is LaTeX's own; the rest are `amsthm`'s, which is what the `amsthm`
 * package provides and what a preamble in the wild relies on.
 */
export const BUILT_IN_THEOREM_ENVIRONMENTS = [
  'theorem',
  'lemma',
  'corollary',
  'proposition',
  'definition',
  'remark',
  'example',
  'notation',
  'claim',
  'conjecture',
  'exercise',
  'problem',
  'solution',
  'proof',
] as const

/**
 * The QED symbol, at the end of a proof and wherever `\qedhere` is written.
 *
 * `\blacksquare` is the AMS symbol Eukolia's own `\newtheorem` styling implies,
 * and it is in MathJax's base command set — verified, not assumed. `\ensuremath`
 * so the mark is right in text mode as well as in mathematics: `\qedhere` most
 * often appears as `… \qedhere` *outside* the final display, which is a text-mode
 * position.
 */
const QEDHERE = '\\def\\qedhere{\\ensuremath{\\blacksquare}}'

/**
 * A `\newenvironment` per name: a bold label, then the body.
 *
 * `\newenvironment` rather than a `\def` of `\begin{name}` — both are accepted by
 * MathJax, and the first is what the construct means, so it is what a reader of
 * this file should see. The closing part is `\par` so a display body does not
 * join whatever follows it.
 */
const environmentDefinition = (name: string): string =>
  `\\newenvironment{${name}}{\\textbf{${name}}\\quad}{\\par}`

/**
 * A proof gets a label and no closing mark.
 *
 * The QED mark is written by `\qedhere`, which is where AMS puts it and where the
 * document says it goes; putting one in the environment's closing part as well
 * would draw two marks on a proof that ends with `\qedhere`, which is most of
 * them.
 */
const PROOF_ENVIRONMENT = '\\newenvironment{proof}{\\textit{Proof.}\\quad}{\\par}'

/**
 * The definitions to give MathJax, newline-separated, in the shape the widgets
 * already pass as a "preamble".
 *
 * The QED mark comes first so a proof's body can use it.
 *
 * Computed once and kept. It is a pure function of two constants — the environment
 * list above and the definition templates — so it cannot go stale, and it is asked
 * for on every decoration rebuild, which is once per keystroke and once per caret
 * move in mathematics. Returning the same string also means the widgets built in
 * one pass all hold the *identical* preamble string, which is what lets
 * `MathWidget.eq` recognise that an equation has not changed.
 */
let builtInDefinitions: string | null = null

export const builtInMathDefinitions = (): string => {
  if (builtInDefinitions !== null) return builtInDefinitions
  builtInDefinitions = [
    QEDHERE,
    PROOF_ENVIRONMENT,
    ...BUILT_IN_THEOREM_ENVIRONMENTS.filter(name => name !== 'proof').map(
      environmentDefinition
    ),
  ].join('\n')
  return builtInDefinitions
}

/**
 * Environment names whose contents Eukolia does not hand to MathJax.
 *
 * **Now empty**, and it is kept empty rather than deleted: the island path below
 * is still the right answer for a diagram the typesetter cannot read, and the one
 * name that was here has moved to the other side of the line.
 *
 * `tikzcd` used to be listed. `tikz-cd` draws diagrams through TikZ, which is a
 * graphics package and not a mathematics engine, so no configuration of the
 * *stock* MathJax renders it — but Eukolia now ships a port of the `tikzcd`
 * extension (`public/mathjax/input/tex/extensions/tikzcd.js`), so the environment
 * is known to MathJax and diagrams are drawn as diagrams. What the list was for
 * still applies to anything that is genuinely un-renderable: an explained source
 * island reads as a limit of the editor, where a red *Unknown environment* box
 * reads as a bug in it.
 */
export const UNRENDERABLE_MATH_ENVIRONMENTS: readonly string[] = []

/** Whether an environment's contents are known to be un-renderable. */
export const isUnrenderableMathEnvironment = (name: string | null): boolean =>
  name !== null &&
  (UNRENDERABLE_MATH_ENVIRONMENTS as readonly string[]).includes(name)
