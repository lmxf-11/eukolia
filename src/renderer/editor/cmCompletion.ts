/**
 * Eukolia — CodeMirror 6 completion and hover for LaTeX.
 *
 * The LaTeX intelligence is engine-agnostic: it lives in `./completion`
 * (Eukolia's own sources plus the ported LaTeX Workshop providers) and in
 * `../document/projectIndex`. This module is only the CodeMirror adapter, the
 * counterpart of the Monaco glue that `monacoLatex.ts` used to hold, so a host
 * mounts it with:
 *
 *     autocompletion({ override: [latexCompletionSource] })
 *     latexHover()
 *
 * Instructions.md §20: the editor is a surface; the intelligence stays in
 * Eukolia's services.
 */

import {
  insertCompletionText,
  snippet,
  type Completion,
  type CompletionContext as CodeMirrorCompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete';
import { hoverTooltip } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

import { setting } from '../core/settings';
import { projectIndex } from '../document/projectIndex';
import {
  analyzeCompletionContext,
  completionRegistry,
  findEnclosingArgument,
  type CompletionEntry,
  type CompletionContext as LatexCompletionContext,
  type CompletionKind
} from './completion';
import { preloadLatexCompletionData, registerLatexWorkshopCompletion } from './latexWorkshopCompletion';
import { LATEX_WORD_PATTERN } from './latexLanguage';

// ---------------------------------------------------------------------------
// The ported LaTeX Workshop providers
// ---------------------------------------------------------------------------

let latexWorkshopData: Promise<void> | null = null;

/**
 * Registers the ported LaTeX Workshop providers and waits for their data.
 *
 * They are the bulk of what a user sees — commands, environments, packages,
 * classes, Unicode mathematics — and they join `completionRegistry` through
 * `registerLatexWorkshopCompletion`, which Monaco's `registerLatexLanguage`
 * used to call. CodeMirror has no equivalent hook, so the registration happens
 * here. Registration is idempotent, and the package datasets are loaded
 * asynchronously, so the load is awaited: without that, the first request after
 * the editor opens would silently be missing every packaged command and
 * environment.
 */
function ensureLatexWorkshopProviders(): Promise<void> {
  registerLatexWorkshopCompletion();
  if (latexWorkshopData !== null) return latexWorkshopData;

  const pending = preloadLatexCompletionData().catch((err) => {
    // A failed preload must not poison every later request: the providers
    // still answer from their bundled defaults.
    console.error('[eukolia] could not preload completion data', err);
    latexWorkshopData = null;
  });
  latexWorkshopData = pending;
  return pending;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The setting that governs each completion kind, or `null` when only
 * `latex.completion.enabled` applies. A kind with no setting of its own is the
 * document-word fallback, which is not a command, an environment or any of the
 * other things the categories name.
 */
const KIND_SETTING: Readonly<Record<CompletionKind, string | null>> = {
  command: 'latex.completion.commands',
  macro: 'latex.completion.commands',
  snippet: 'latex.completion.commands',
  environment: 'latex.completion.environments',
  package: 'latex.completion.packages',
  class: 'latex.completion.packages',
  citation: 'latex.completion.citations',
  reference: 'latex.completion.references',
  label: 'latex.completion.references',
  file: 'latex.completion.files',
  symbol: 'latex.completion.unicodeMath',
  word: null
};

/** Every setting is read per request, so a change takes effect immediately. */
function kindEnabled(kind: CompletionKind): boolean {
  const key = KIND_SETTING[kind];
  return key === null || setting.bool(key);
}

/**
 * How many registry entries a request asks for.
 *
 * The ported LaTeX Workshop providers answer with their whole dataset — over a
 * thousand commands — and leave the filtering to the editor, because their
 * `filterText` cannot be used as CodeMirror's label without breaking the match
 * against the typed backslash. Monaco therefore asked for 250, which the ported
 * dataset alone filled: Eukolia's own labels, citations, macros and files were
 * never in the list at all in any `\command` context. CodeMirror does its own
 * matching, ranking and rendering (at most `maxRenderedOptions`), so the cap
 * only has to be above the dataset rather than a display limit.
 */
const COMPLETION_LIMIT = 5000;

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

interface KindPresentation {
  /** CodeMirror's `Completion.type`, which picks the icon. */
  type: string;
  /** CodeMirror's `Completion.boost`, a -99…99 ranking adjustment. */
  boost: number;
}

/**
 * Eukolia's completion kinds mapped onto CodeMirror's icon types and ranking.
 *
 * CodeMirror's icon set is `class`, `constant`, `enum`, `function`,
 * `interface`, `keyword`, `method`, `namespace`, `property`, `text`, `type` and
 * `variable`; each kind takes the one that reads best for LaTeX, and every kind
 * gets a distinct icon. The boosts rank what a LaTeX author is most likely to
 * want — labels, references and citations above commands, document words last —
 * because CodeMirror adds the boost to its own match score rather than sorting
 * by it.
 */
const KIND_PRESENTATION: Readonly<Record<CompletionKind, KindPresentation>> = {
  label: { type: 'type', boost: 16 },
  reference: { type: 'variable', boost: 16 },
  citation: { type: 'namespace', boost: 16 },
  file: { type: 'property', boost: 12 },
  environment: { type: 'enum', boost: 12 },
  package: { type: 'interface', boost: 10 },
  class: { type: 'class', boost: 10 },
  command: { type: 'keyword', boost: 8 },
  macro: { type: 'function', boost: 8 },
  snippet: { type: 'snippet', boost: 6 },
  symbol: { type: 'constant', boost: 4 },
  word: { type: 'text', boost: -12 }
};

/**
 * Eukolia's `sortText` as an extra nudge.
 *
 * Its sources prefix the key with a priority digit — `0` for the project index'
 * own labels and cited keys, `1` for macros, `2` for files, `9` for the
 * document-word fallback — and CodeMirror has no `sortText`. The digit is
 * folded into `boost` instead, which keeps the sources' intended order between
 * equally good matches without overriding a better match.
 */
function sortBoost(sortText: string | undefined): number {
  const digit = /^\d/.exec(sortText ?? '')?.[0];
  if (digit === undefined) return 0;
  return (9 - Number(digit)) * 2;
}

// ---------------------------------------------------------------------------
// Snippet bodies
// ---------------------------------------------------------------------------

/**
 * Rewrites a snippet body into the placeholder syntax CodeMirror understands.
 *
 * `CompletionEntry.insertTextFormat === 'snippet'` marks two different
 * dialects. Entries from Eukolia's own sources use Monaco's `${1:placeholder}`,
 * which CodeMirror parses unchanged. The ported LaTeX Workshop providers keep
 * VS Code's forms, and two of them would otherwise be inserted as literal text:
 *
 *  - a bare tab stop (`$0`, `$1`) — CodeMirror only recognises the braced form,
 *    so `\begin{figure}\n\t$0\n\end{figure}` would leave a literal `$0` in the
 *    document;
 *  - a VS Code variable (`${1:${TM_SELECTED_TEXT}}`) — CodeMirror's snippet
 *    engine has no variables at all, and `TM_SELECTED_TEXT` means "the current
 *    selection", which CodeMirror cannot carry into a placeholder. The default
 *    is kept when the provider gave one (`${1:${TM_SELECTED_TEXT:bold}}`
 *    becomes `${1:bold}`) and the field becomes an empty tab stop otherwise.
 */
function snippetTemplate(insertText: string): string {
  return insertText
    .replace(/\$\{(\d+):\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}\}/g, (_match, field: string, _variable: string, fallback?: string) =>
      fallback === undefined ? `\${${field}}` : `\${${field}:${fallback}}`
    )
    .replace(/\$(?!\{)(\d+)/g, (_match, field: string) => `\${${field}}`);
}

/**
 * The `apply` value for one entry.
 *
 * A plain entry applies its `insertText`. An entry carrying a snippet body
 * applies it through CodeMirror's `snippet()` helper, so its placeholders become
 * real tab stops. An entry carrying its own replacement range — the ported LaTeX
 * Workshop providers put the text edit they were built with there, e.g. the path
 * of `\input{...}` up to the brace — replaces that range rather than the result's
 * one `from`/`to`, which is what Monaco did per suggestion and what CodeMirror's
 * result-level range cannot express.
 */
function applyFor(entry: CompletionEntry, isSnippet: boolean): Completion['apply'] {
  const range = entry.range;
  if (!range && !isSnippet) return entry.insertText;

  const applySnippet = isSnippet ? snippet(snippetTemplate(entry.insertText)) : null;
  return (view, completion, from, to) => {
    const length = view.state.doc.length;
    const start = range ? Math.max(0, Math.min(range.from, length)) : from;
    const end = range ? Math.max(start, Math.min(range.to, length)) : to;
    if (applySnippet) {
      applySnippet(view, completion, start, end);
      return;
    }
    view.dispatch({ ...insertCompletionText(view.state, entry.insertText, start, end), scrollIntoView: true });
  };
}

/**
 * Documentation as a `pre` block.
 *
 * Monaco rendered an entry's documentation as a fenced LaTeX code block, which
 * kept macro definitions monospaced. CodeMirror has no markdown renderer, so the
 * same text is handed over as DOM; the element is only built when the info box
 * is actually shown.
 */
function documentationDom(text: string): Node {
  const dom = document.createElement('pre');
  dom.className = 'eukolia-completion-documentation';
  dom.style.whiteSpace = 'pre-wrap';
  dom.style.margin = '0';
  dom.textContent = text;
  return dom;
}

/** Converts one Eukolia entry into a CodeMirror completion. */
function toCompletion(entry: CompletionEntry): Completion {
  const presentation = KIND_PRESENTATION[entry.kind];
  const isSnippet = entry.insertTextFormat === 'snippet';
  const documentation = entry.documentation;
  return {
    label: entry.label,
    detail: entry.detail,
    info: documentation === undefined ? undefined : () => ({ dom: documentationDom(documentation) }),
    // `snippet` is the type Overleaf's own CodeMirror completions use for a
    // completion that expands a template; CodeMirror shows it via
    // `cm-completionIcon-snippet`.
    type: isSnippet ? 'snippet' : presentation.type,
    boost: Math.max(-99, Math.min(99, presentation.boost + sortBoost(entry.sortText))),
    apply: applyFor(entry, isSnippet)
  };
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * The word ending at `offset`, or an empty range at the caret.
 *
 * The pattern is LaTeX's own word pattern — an optional backslash, then letters,
 * or digits (`LATEX_WORD_PATTERN`, which is what Monaco's model used and what an
 * editor replaces unless a suggestion carries an explicit range). CodeMirror
 * matches and filters against it too, so `\secti` is replaced whole and
 * `\ref{kn` only loses `kn`.
 */
const WORD_END = new RegExp(`(?:${LATEX_WORD_PATTERN.source})$`);

function wordRange(text: string, offset: number): { from: number; to: number } {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const match = WORD_END.exec(text.slice(lineStart, offset));
  return match ? { from: offset - match[0].length, to: offset } : { from: offset, to: offset };
}

/**
 * The URI Eukolia's project index knows this document under.
 *
 * Monaco handed the providers its model URI (`file:///…`), which never matched
 * the index's keys — `DocumentModel.uri` is a file path — so the ported
 * providers saw no document at all and `\usepackage{tikz}` never offered
 * `\draw`. CodeMirror has no document-URI facet to read instead, so the document
 * is identified by its text: the open document whose content is exactly this
 * text. Two open buffers with identical content resolve to no document rather
 * than to a guess, because the wrong document would offer the wrong packages;
 * with a single match the document-scoped data is right by construction, since
 * it is derived from this very text.
 */
function documentUriFor(text: string): string {
  let found: string | null = null;
  for (const document of projectIndex.getAllDocuments()) {
    if (document.getText() !== text) continue;
    if (found !== null) return '';
    found = document.uri;
  }
  return found ?? '';
}

/**
 * A CodeMirror 6 completion source over Eukolia's LaTeX completion registry.
 *
 * Everything the registry knows is offered — the ported LaTeX Workshop
 * providers, the project index' labels, citations, macros and files, and the
 * document-word fallback — filtered by the `latex.completion.*` settings. The
 * registry is asynchronous (`CompletionRegistry.provide` awaits every source),
 * so this returns a promise, which is a `CompletionSource` and is how Monaco's
 * provider worked for the same reason.
 */
export async function latexCompletionSource(context: CodeMirrorCompletionContext): Promise<CompletionResult | null> {
  if (!setting.bool('latex.completion.enabled')) return null;

  await ensureLatexWorkshopProviders();

  const text = context.state.doc.toString();
  const latex: LatexCompletionContext = analyzeCompletionContext(text, context.pos, documentUriFor(text));

  const entries = await completionRegistry.provide(latex, { limit: COMPLETION_LIMIT });
  const offered = entries.filter((entry) => kindEnabled(entry.kind));
  if (offered.length === 0) return null;

  const { from, to } = wordRange(text, context.pos);
  return { from, to, options: offered.map(toCompletion) };
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

/** One line of hover information. */
export interface LatexHoverLine {
  /** `title` is the bold first line, `code` a monospaced block, `item` a bullet. */
  kind: 'title' | 'text' | 'code' | 'item' | 'link';
  text: string;
  /** Target of a `link` line. */
  href?: string;
}

/** The token under the pointer and what is known about it. */
export interface LatexHoverInfo {
  /** Start of the annotated range, as a document offset. */
  from: number;
  /** End of the annotated range, exclusive. */
  to: number;
  lines: LatexHoverLine[];
}

/**
 * The tokens a hover could be about, best first: the word containing the pointer
 * — including the backslash of a `\command` — and then the argument of the
 * enclosing command, when it says something the word does not.
 */
function hoverCandidates(text: string, offset: number): Array<{ text: string; from: number; to: number }> {
  const candidates: Array<{ text: string; from: number; to: number }> = [];

  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const newline = text.indexOf('\n', offset);
  const lineEnd = newline === -1 ? text.length : newline;
  const line = text.slice(lineStart, lineEnd);
  const column = offset - lineStart;

  // Monaco's `getWordAtPosition` treats a position directly after a word as
  // belonging to it — which is also what CodeMirror needs, since the position it
  // reports for a hover can be the boundary on either side of the character
  // under the pointer — so the comparison is inclusive at both ends.
  for (const match of line.matchAll(/\\?[a-zA-Z@]+|\d+/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (column < start || column > end) continue;
    candidates.push({ text: match[0], from: lineStart + start, to: lineStart + end });
    break;
  }

  const argument = findEnclosingArgument(text, offset);
  if (argument) {
    const argumentText = text.slice(argument.from + 1, argument.to - 1).trim();
    if (argumentText && !candidates.some((candidate) => candidate.text === argumentText)) {
      candidates.push({ text: argumentText, from: argument.from + 1, to: argument.to - 1 });
    }
  }

  return candidates;
}

/**
 * What the project index knows about one token, in the order Monaco asked: the
 * macro, the label occurrences, the bibliography entry.
 */
function describeToken(token: string): LatexHoverLine[] {
  const macro = projectIndex.getMacro(token.replace(/^\\/, ''));
  if (macro && token.startsWith('\\')) {
    const argumentSummary = macro.args === 0 ? 'no arguments' : `${macro.args} argument${macro.args === 1 ? '' : 's'}`;
    return [
      { kind: 'title', text: `\\${macro.name} — ${argumentSummary}` },
      { kind: 'code', text: macro.definition }
    ];
  }

  const labels = projectIndex.getLabelOccurrences(token);
  if (labels.length > 0) {
    return [
      { kind: 'title', text: `Label ${token} defined at:` },
      ...labels.map<LatexHoverLine>((occurrence) => ({
        kind: 'item',
        text: `${occurrence.file.split(/[\\/]/).pop()}:${occurrence.line}`
      }))
    ];
  }

  const bibEntry = projectIndex.getBibEntry(token);
  if (!bibEntry) return [];

  const lines: LatexHoverLine[] = [{ kind: 'title', text: bibEntry.title ?? bibEntry.key }];
  if (bibEntry.authors && bibEntry.authors.length > 0) {
    lines.push({ kind: 'text', text: bibEntry.authors.join(', ') });
  }
  const venue = bibEntry.journal ?? bibEntry.booktitle;
  if (venue || bibEntry.year) {
    lines.push({ kind: 'text', text: `${venue ?? ''}${venue && bibEntry.year ? ' ' : ''}${bibEntry.year ? `(${bibEntry.year})` : ''}` });
  }
  if (bibEntry.doi) {
    lines.push({ kind: 'link', text: `doi: ${bibEntry.doi}`, href: `https://doi.org/${bibEntry.doi}` });
  } else if (bibEntry.url) {
    lines.push({ kind: 'link', text: bibEntry.url, href: bibEntry.url });
  }
  return lines;
}

/**
 * Resolves the hover information for `offset`, or `null` when there is nothing
 * to say.
 *
 * The project index is asked, in order, for the macro, the label occurrences and
 * the bibliography entry; a token it knows nothing about is answered with
 * nothing at all. That last part is deliberate, and it was learned from the
 * alternative: the resolution used to end by naming the enclosing environment —
 * `Inside \begin{theorem}` — for any token the index did not recognise, which is
 * every ordinary word of prose inside any environment. Reading a document meant
 * being told which environment you were in every time the pointer crossed a
 * word, in a box that covered the line you were reading. A hover earns its
 * interruption only when it says something the reader cannot see for themselves;
 * the environment you are in is already on screen in the breadcrumbs.
 *
 * The one deliberate difference from the Monaco provider this replaces is which
 * token is asked: Monaco only fell back to the enclosing command's argument when
 * the pointer was on no word at all, which left every punctuated name
 * unreachable, because the LaTeX word pattern splits `\ref{sec:intro}` at the
 * colon and `\cite{knuth1984}` between the letters and the digits. Here the
 * argument is also tried when the word under the pointer turns out to be
 * something the index knows nothing about, so the labels and citation keys that
 * fallback exists for can actually be hovered.
 *
 * `latex.hover.enabled` is read here rather than when the extension is built, so
 * toggling the setting takes effect on the next hover without rebuilding the
 * editor. Exported with `latexHover` so the resolution rules can be exercised
 * without mounting an editor.
 */
export function latexHoverInfo(text: string, offset: number): LatexHoverInfo | null {
  if (!setting.bool('latex.hover.enabled')) return null;

  const position = Math.max(0, Math.min(offset, text.length));
  const candidates = hoverCandidates(text, position);
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    const lines = describeToken(candidate.text);
    if (lines.length > 0) return { from: candidate.from, to: candidate.to, lines };
  }

  // Nothing is known about the token, so there is nothing to say about it: no
  // tooltip. The enclosing environment is deliberately *not* the answer (see the
  // comment above) — it is what turned every word of prose into a popup.
  return null;
}

/** Builds the tooltip's DOM from the resolved lines. */
function renderHover(info: LatexHoverInfo): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'eukolia-hover';

  let list: HTMLUListElement | null = null;
  for (const line of info.lines) {
    if (line.kind === 'item') {
      if (list === null) {
        list = document.createElement('ul');
        list.className = 'eukolia-hover-list';
        dom.appendChild(list);
      }
      const item = document.createElement('li');
      item.textContent = line.text;
      list.appendChild(item);
      continue;
    }

    list = null;
    const element = document.createElement(line.kind === 'code' ? 'pre' : 'div');
    element.className = `eukolia-hover-${line.kind}`;
    if (line.kind === 'title') element.style.fontWeight = '600';
    if (line.kind === 'code') {
      element.style.whiteSpace = 'pre-wrap';
      element.style.margin = '0';
    }
    if (line.kind === 'link' && line.href !== undefined) {
      const anchor = document.createElement('a');
      anchor.href = line.href;
      anchor.textContent = line.text;
      element.appendChild(anchor);
    } else {
      element.textContent = line.text;
    }
    dom.appendChild(element);
  }
  return dom;
}

/**
 * Hover information for LaTeX commands, labels, references and citations.
 *
 * Nothing is shown for plain text: the tooltip only appears when the token under
 * the pointer is something the project index can describe. The tooltip annotates
 * the token it describes, so the range it highlights is the one the information
 * was resolved for. It closes when the document changes, as Monaco's hover
 * widget did, rather than floating stale information over edited text.
 */
export function latexHover(): Extension {
  return hoverTooltip(
    (view, pos) => {
      const info = latexHoverInfo(view.state.doc.toString(), pos);
      if (!info) return null;
      return {
        pos: info.from,
        end: info.to,
        // Built on demand: CodeMirror calls `create` only when it shows the
        // tooltip, so a plain hover never touches the DOM.
        create: () => ({ dom: renderHover(info) })
      };
    },
    { hideOnChange: true }
  );
}
