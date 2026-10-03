/**
 * Eukolia Snippet Engine — editor-agnostic facade over the HyperSnips port.
 *
 * The ported implementation lives in `src/renderer/vendor/hypersnips/` and is a
 * faithful transcription of `References/hypersnips/src`. This facade is the only
 * thing Eukolia editors should talk to: it takes a document-shaped text source
 * and returns plain data plus a `SnippetExpansion` whose tab stops and mirrored
 * placeholders are already positioned in document coordinates.
 *
 * Ported from References/hypersnips/src/{extension,completion,hsnippetInstance}.ts
 * (MIT, (c) 2019 Ian Ornelas). Modified for Eukolia.
 */

import * as vscode from 'vscode';
import {
  CompletionInfo,
  HSnippet,
  SnippetExpansion,
  getCompletions as getSnippetCompletions,
  getSnippetBody,
  parse,
  setSnippetHost,
  stripPlaceholders,
  type SnippetEditBuilder,
  type SnippetEditorLike
} from '../vendor/hypersnips';
import { renderBody } from './eusnips/body';
import { getContextProvider, setContextProvider as setActiveContextProvider, type ContextProvider } from './context';
import {
  createEditableDocument,
  createStringDocument,
  createTextDocumentAdapter,
  type DocumentLike
} from './documentAdapter';

export type { CompletionInfo, HSnippet, SnippetExpansion, DocumentLike, SnippetEditBuilder };

// ---------------------------------------------------------------------------
// Public data types
// ---------------------------------------------------------------------------

export interface SnippetSource {
  /** File name, e.g. `latex.hsnips`. Its basename selects the language. */
  name: string;
  content: string;
  /**
   * Language this source applies to. `all` (or a file literally named
   * `all.hsnips`) makes the snippets global, exactly like the reference.
   */
  language: string;
}

export interface SnippetExpansionCandidate {
  snippet: HSnippet;
  /** Text that will be replaced when the snippet expands. */
  range: vscode.Range;
  /** Match groups of a regex trigger (`m` inside code blocks), else `[]`. */
  matchGroups: string[];
  /** Text shown in the completion list. */
  label: string;
  /** True for `A`-flag snippets that fire as soon as the trigger matches. */
  automatic: boolean;
  source: CompletionInfo;
}

export interface SnippetCompletionContext {
  /** Full text of the document at the moment of the request. */
  text: string;
  /** UTF-16 offset of the cursor inside `text`. */
  offset: number;
  languageId: string;
  /** Trigger character reported by the editor, when there is one. */
  triggerCharacter?: string;
  /** Reuse a live document adapter instead of re-reading `text`. */
  doc?: DocumentLike;
}

export interface AutomaticExpansionResult {
  candidate: SnippetExpansionCandidate;
  /** Range in the post-change document that the expansion replaces. */
  range: vscode.Range;
  /** Offset in the post-change document where the snippet text starts. */
  insertOffset: number;
  /** Offset in the post-change document where the replaced trigger ends. */
  replaceEnd: number;
  expansion: SnippetExpansion;
  /** Inserted text with placeholder markup removed (`expansion.plainText`). */
  text: string;
}

export interface SnippetDocumentChange {
  /** Range in the *pre-change* document that was replaced. */
  range: vscode.Range;
  /** Inserted text. */
  text: string;
  /**
   * Document text *after* the change has been applied.
   *
   * May be a getter, and may be left out altogether when `doc` is supplied: it is
   * only read once a snippet has actually matched, so a host is not forced to
   * materialise its whole buffer for every keystroke. (A getter satisfies the
   * declared type, which is why this is not optional by accident — the engine
   * asks for it through `textOf`, which reads it at most once per decision.)
   */
  textAfter?: string;
  /**
   * Offset of `range.start` in `textAfter`, when the editor already knows it.
   *
   * A CodeMirror host has the offset of the keystroke to hand, and the engine
   * otherwise has to count lines through the whole buffer to recover it.
   */
  offset?: number;
}

export interface ResolvedVariables {
  workspaceUri: string;
  fileUri: string;
  fileName: string;
  dirName: string;
  date: string;
  /**
   * Eukolia addition: the resolver may also supply VS Code-style variables
   * (`TM_FILENAME`, `CURRENT_YEAR`, …). They are carried through untouched so
   * callers can read them without a second lookup.
   */
  [name: string]: string;
}

export type VariableResolver = (names: string[], defaults: ResolvedVariables) => ResolvedVariables | void;

export interface SelectionSnapshot {
  text: string;
  timestamp: number;
}

export interface ExpandOptions {
  /** Document the expansion targets. `text` is used when this is omitted. */
  doc?: DocumentLike;
  /** Document text; kept so geometry stays computable without a live buffer. */
  text?: string;
  languageId?: string;
  editor?: SnippetEditorLike;
  workspaceUri?: string;
  /** `${VISUAL}` source; defaults to the engine's selection provider. */
  selection?: SelectionSnapshot;
  /**
   * Whether the expansion becomes the engine's active tab-stop target.
   *
   * Defaults to `true`, which is what the `A`-flag path wants. A completion
   * provider that expands *every* candidate to render previews must pass `false`
   * and then call {@link SnippetEngine.pushExpansion} for the candidate the user
   * actually accepted — otherwise the stack fills up with previews that were
   * never inserted.
   */
  pushToStack?: boolean;
}

export interface PlaceholderLocation {
  /** `undefined` for the final `$0` cursor. */
  id: number | undefined;
  /** Snippet-relative offsets into `ExpansionGeometry.text`. */
  from: number;
  to: number;
  /** Absolute document offsets in the buffer the expansion targeted. */
  documentFrom: number;
  documentTo: number;
  /** Index into `SnippetExpansion.parts`. */
  partIndex: number;
}

export interface ExpansionGeometry {
  text: string;
  /** Where `text` starts in the document. */
  from: number;
  /** Where `text` ends in the document. */
  to: number;
  /** Locations of the tab stop the expansion currently has selected. */
  selected: PlaceholderLocation[];
  placeholders: PlaceholderLocation[];
}

interface ExpansionRecord {
  /**
   * Buffer text the instance's own `range`/`parts` positions are expressed in.
   * `SnippetExpansion.update()` translates them in that space, so the geometry
   * transform is: relative = partOffset - instance.range.start.
   */
  text: string;
}

let activeEngine: SnippetEngine | null = null;

/** The process-wide engine. Editors normally share one instance. */
export function getSnippetEngine(): SnippetEngine {
  if (!activeEngine) activeEngine = new SnippetEngine();
  return activeEngine;
}

export function setSnippetEngine(engine: SnippetEngine | null): void {
  activeEngine = engine;
}

export class SnippetEngine {
  private readonly snippetsByLanguage = new Map<string, HSnippet[]>();
  private readonly stack: SnippetExpansion[] = [];
  private readonly sources: SnippetSource[] = [];
  private readonly expansionRecords = new WeakMap<SnippetExpansion, ExpansionRecord>();
  /**
   * How to push new buffer text into each expansion's own document.
   *
   * Only an expansion the engine built for itself has one; a caller that passed
   * its own live document owns that document and keeps it current already.
   */
  private readonly expansionDocuments = new WeakMap<SnippetExpansion, (text: string) => void>();
  private variableResolver: VariableResolver | null = null;
  private selectionProvider: (() => SelectionSnapshot | undefined) | null = null;
  private warningSink: ((message: string) => void) | null = null;
  private workspaceUriProvider: (() => string) | null = null;
  /**
   * Whether a snippet's backtick code blocks may run.
   *
   * `null` means "no opinion", which is `true`: the setting exists to turn
   * scripting *off*, and an engine nobody has configured keeps the reference's
   * behaviour. The shell installs `snippets.allowJavaScript` here.
   */
  private scriptingAllowedProvider: (() => boolean) | null = null;
  /**
   * Called once for every expansion this engine builds.
   *
   * Set by the shell to feed the trigger history. It lives on the engine because
   * {@link expand} is the one place a `SnippetExpansion` comes into being — an
   * `A`-flag snippet firing by itself and a completion being accepted both arrive
   * there — so a consumer attached here cannot miss an expansion, and cannot
   * invent one either: the method returns exactly one instance per call, and
   * nothing calls it merely to ask what a snippet *would* do.
   */
  private expansionListener: ((candidate: SnippetExpansionCandidate, expansion: SnippetExpansion) => void) | null = null;

  constructor() {
    // Wire the ported engine's injectable seams onto this instance. The
    // instance is captured in `engine` because these callbacks are invoked from
    // a different `this` (`setSnippetHost` is module-level).
    const engine = this;
    setSnippetHost({
      getSelectedText: () => engine.selectionProvider?.(),
      warn: (message) => {
        if (engine.warningSink) engine.warningSink(message);
        else console.warn(message);
      },
      getWorkspaceUri: () => engine.workspaceUriProvider?.() ?? '',
      // The reference left `${TM_FILENAME}` and friends to VS Code's snippet
      // controller; this is the seam that replaces it. Asked once per expansion,
      // with the document the expansion is being laid out in.
      getVariables: () => engine.variableValues()
    });
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Reference `loadSnippets()`: parse every source, expose `all` to every other
   * language, then sort by descending priority.
   */
  loadSnippetSources(sources: Array<{ name: string; content: string; language: string }>): void {
    this.sources.length = 0;
    this.snippetsByLanguage.clear();

    for (const source of sources) {
      this.sources.push(source);
      const language = (source.language || languageFromName(source.name)).toLowerCase();
      const parsed = parse(source.content, source.name);
      const existing = this.snippetsByLanguage.get(language);
      if (existing) existing.push(...parsed);
      else this.snippetsByLanguage.set(language, [...parsed]);
    }

    const globalSnippets = this.snippetsByLanguage.get('all');
    if (globalSnippets) {
      for (const [language, snippetList] of this.snippetsByLanguage.entries()) {
        if (language != 'all') snippetList.push(...globalSnippets);
      }
    }

    // Sort snippets by descending priority. `Array#sort` is stable, so snippets
    // sharing a priority keep their file order — same as the reference.
    for (const snippetList of this.snippetsByLanguage.values()) {
      snippetList.sort((a, b) => b.priority - a.priority);
    }
  }

  /**
   * Eukolia addition: parse and append sources *after* the ones already loaded,
   * without clearing them.
   *
   * The managed library is loaded first and a project's own `snips/` folder is
   * appended here, so a project can override the user's library. Doing that with
   * a second {@link loadSnippetSources} call would throw the first one away.
   */
  addSnippetSources(sources: Array<{ name: string; content: string; language: string }>): void {
    const touched = new Set<string>();
    for (const source of sources) {
      this.sources.push(source);
      const language = (source.language || languageFromName(source.name)).toLowerCase();
      const parsed = parse(source.content, source.name);
      const existing = this.snippetsByLanguage.get(language);
      if (existing) existing.push(...parsed);
      else this.snippetsByLanguage.set(language, [...parsed]);
      touched.add(language);
    }

    // Once per language, not once per source. A project folder holding two
    // `latex` files had every `all` snippet appended to `latex` twice: the same
    // entry offered twice by the completion list and matched twice on every
    // keystroke, with the cost growing with the number of files in the folder.
    for (const language of touched) this.spreadGlobalsFor(language);

    for (const snippetList of this.snippetsByLanguage.values()) {
      snippetList.sort((a, b) => b.priority - a.priority);
    }
  }

  /** Copies a language's own snippets into every other language, as `all` does. */
  private spreadGlobalsFor(language: string): void {
    const own = this.snippetsByLanguage.get(language);
    if (!own || language === 'all') return;
    const globalSnippets = this.snippetsByLanguage.get('all');
    if (globalSnippets) own.push(...globalSnippets);
  }

  /**
   * Eukolia addition: re-sort a language's snippets after a property only the
   * caller could know was applied to them.
   *
   * The managed snippet format carries a per-snippet priority, which the ported
   * parser cannot represent, so the projection in `snippets/eusnips/hsnips.ts`
   * sets it on the parsed `HSnippet` objects after loading. The engine's own sort
   * ran before that, which would leave those snippets in the wrong place. This
   * re-runs it, and like {@link loadSnippetSources} it is a stable sort, so
   * snippets sharing a priority keep their file order.
   */
  resortLanguage(languageId: string): void {
    const list = this.snippetsByLanguage.get((languageId || 'all').toLowerCase());
    if (list) list.sort((a, b) => b.priority - a.priority);
  }

  /** All snippets for a language, including the `all` globals, priority sorted. */
  getSnippets(languageId: string): HSnippet[] {
    const language = (languageId || 'all').toLowerCase();
    const snippets = this.snippetsByLanguage.get(language) ?? this.snippetsByLanguage.get('all');
    return snippets ? [...snippets] : [];
  }

  /** All automatic snippets for a language, priority sorted. */
  getAutomaticSnippets(languageId: string): HSnippet[] {
    return this.getSnippets(languageId).filter((s) => s.automatic);
  }

  /**
   * Eukolia addition: register already-built `HSnippet` objects (no `.hsnips`
   * text). Used by hosts that construct snippets programmatically and by tests.
   */
  addSnippets(languageId: string, snippets: HSnippet[]): void {
    const language = (languageId || 'all').toLowerCase();
    const existing = this.snippetsByLanguage.get(language);
    if (existing) existing.push(...snippets);
    else this.snippetsByLanguage.set(language, [...snippets]);
    this.snippetsByLanguage.get(language)!.sort((a, b) => b.priority - a.priority);
  }

  get loadedSourceNames(): readonly string[] {
    return this.sources.map((s) => s.name);
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /** Eukolia supplies math-mode / environment context from its own LaTeX parser. */
  setContextProvider(provider: ContextProvider | null): void {
    setActiveContextProvider(provider);
  }

  /** Eukolia supplies `TM_*`-style and date/file variables. */
  setVariableResolver(resolver: VariableResolver | null): void {
    this.variableResolver = resolver;
  }

  /**
   * Eukolia supplies `${VISUAL}` text here. The ported instance only honours a
   * snapshot younger than five seconds, exactly like the reference.
   */
  setSelectionProvider(provider: (() => SelectionSnapshot | undefined) | null): void {
    this.selectionProvider = provider;
  }

  setWorkspaceUriProvider(provider: (() => string) | null): void {
    this.workspaceUriProvider = provider;
  }

  setWarningSink(sink: ((message: string) => void) | null): void {
    this.warningSink = sink;
  }

  /**
   * Installs the answer to "may snippet code blocks run?"; `null` allows them.
   *
   * Asked once per expansion rather than pushed, so a change to
   * `snippets.allowJavaScript` takes effect on the next snippet instead of
   * needing the settings editor to remember to tell the engine.
   */
  setScriptingAllowedProvider(provider: (() => boolean) | null): void {
    this.scriptingAllowedProvider = provider;
  }

  /** Whether this expansion may run its snippet's code blocks. */
  private scriptingAllowed(): boolean {
    return this.scriptingAllowedProvider?.() ?? true;
  }

  /** Mirrors the reference's `hsnips.leaveSnippet`. */
  clearStack(): void {
    this.stack.length = 0;
  }

  get activeExpansion(): SnippetExpansion | undefined {
    return this.stack[0];
  }

  get allExpansions(): readonly SnippetExpansion[] {
    return this.stack;
  }

  popExpansion(): SnippetExpansion | undefined {
    return this.stack.shift();
  }

  get stackDepth(): number {
    return this.stack.length;
  }

  resolveVariables(defaults: ResolvedVariables, names: string[] = []): ResolvedVariables {
    if (!this.variableResolver) return defaults;
    return this.variableResolver(names, defaults) ?? defaults;
  }

  /**
   * The values a snippet body's `${NAME}` variables resolve to.
   *
   * The resolver is the shell's — it is the only thing that knows the active
   * file — and it is handed the base values the reference passed it
   * (`workspaceUri`, `fileName`, `date`, …) so a resolver written against that
   * shape keeps working. A resolver that answers nothing (or no resolver at all)
   * leaves only those base values, and a name that is in neither falls back to
   * the variable's own default in the body.
   */
  private variableValues(): Record<string, string | undefined> {
    const workspaceUri = this.workspaceUriProvider?.() ?? '';
    const fileName = workspaceUri.replace(/^.*[\\/]/, '');
    return this.resolveVariables({
      workspaceUri,
      fileUri: workspaceUri,
      fileName,
      dirName: workspaceUri.replace(/[\\/][^\\/]*$/, ''),
      date: new Date().toISOString()
    });
  }

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  /**
   * Reference `getCompletions` plus the `math` / `nonmath` flag filters that the
   * reference applied inline in `extension.ts`.
   */
  getCompletions(context: SnippetCompletionContext): SnippetExpansionCandidate[] {
    const doc = context.doc ?? createStringDocument(context.text, context.languageId);
    const position = positionFromOffset(context.text, context.offset);
    const { auto, suggestions } = getSnippetCompletions(
      createTextDocumentAdapter(doc),
      position,
      this.getSnippets(context.languageId)
    );

    const inMath = this.isMathAt(doc, context.offset, context.languageId, context.triggerCharacter);

    return [
      ...this.contextCandidates(auto, true, inMath),
      ...this.contextCandidates(suggestions, false, inMath)
    ];
  }

  /** The `math` / `nonmath` flag filter, applied to one class of match. */
  private contextCandidates(
    matches: readonly CompletionInfo[],
    automatic: boolean,
    inMath: boolean
  ): SnippetExpansionCandidate[] {
    const candidates: SnippetExpansionCandidate[] = [];
    for (const info of matches) {
      const snippet = info.snippet;
      if (snippet.math && !inMath) continue;
      if (snippet.nonmath && inMath) continue;
      candidates.push({
        snippet,
        range: info.range,
        matchGroups: info.groups,
        label: info.label,
        automatic,
        source: info
      });
    }
    return candidates;
  }

  private isMathAt(
    doc: DocumentLike,
    offset: number,
    languageId: string,
    triggerCharacter?: string
  ): boolean {
    if (typeof doc.isMathAt === 'function') {
      try {
        if (doc.isMathAt(offset)) return true;
      } catch {
        /* fallback to context provider */
      }
    }
    return getContextProvider()
      .createDetector({ doc, offset, languageId, triggerCharacter })
      .isMath();
  }

  /** VS Code completion item for a candidate, for editor adapters. */
  toCompletionItem(candidate: SnippetExpansionCandidate): vscode.CompletionItem {
    return candidate.source.toCompletionItem();
  }

  // -------------------------------------------------------------------------
  // Automatic (`A` flag) expansion
  // -------------------------------------------------------------------------

  /**
   * Reference `workspace.onDidChangeTextDocument` handler.
   *
   * Keystroke detection, the single-character filter, the `insertingSnippet`
   * guard and the math/nonmath filter are all preserved; the editor work is
   * returned as data instead of being performed here.
   *
   * `doc` is the document *after* the change (what the reference read from
   * `e.document`). `textBefore` is the buffer the snippet will be laid out in,
   * which is what the reference's `editor.document` pointed at.
   *
   * Eukolia addition: `docAfterInsertion` is the buffer the *expansion* will
   * occupy — the text after the change with the trigger replaced by the snippet.
   * A caller that can produce it should, because the expansion's tab stops are
   * positions in that text and nothing else can be used to answer where they are.
   */
  tryAutomaticExpansion(
    change: SnippetDocumentChange,
    languageId: string,
    doc?: DocumentLike,
    textBefore?: string,
    docAfterInsertion?: DocumentLike
  ): AutomaticExpansionResult | null {
    // Detect only events that come from keystrokes.
    if (change.text.length != 1) return null;

    const snippets = this.getAutomaticSnippets(languageId);
    if (!snippets.length) return null;

    // The caret the completion is matched at. `change.range` is a zero-width
    // insertion point for every caller that produces keystrokes, so its position
    // is the position of the typed character and the caret is that plus the
    // character itself — no line counting over the document is needed.
    const insertion = change.range.start.isEqual(change.range.end);
    const document = doc ?? createStringDocumentFrom(change, languageId);
    const mainChangePosition = insertion
      ? positionAfterInsertion(change.range.start, change.text)
      : positionFromOffset(
          textOf(change, document),
          (change.offset ?? offsetFromPosition(textOf(change, document), change.range.start)) + change.text.length
        );
    const caretOffset =
      insertion && change.offset != null
        ? change.offset + change.text.length
        : offsetFromPosition(textOf(change, document), mainChangePosition);

    // One scan of the corpus, filtered once. The reference filtered the same
    // match set a second time (`getCompletions`) which scanned every snippet and
    // re-read the document again; on the keystroke path that work is pure waste.
    //
    // Nothing above this line reads the document's *text* unless it has to: a host
    // that can answer `offsetAt`/`positionAt`/`lineAt` through its own line index
    // (CodeMirror can) hands over a document and never has the whole buffer
    // materialised as a string for a keystroke that expands nothing — which is
    // almost every keystroke. The string is asked for below, where a snippet has
    // actually matched and the expansion needs the text it is laid out in.
    const { auto } = getSnippetCompletions(
      createTextDocumentAdapter(document),
      mainChangePosition,
      snippets,
      { automaticOnly: true, typedChar: change.text }
    );
    if (!auto.length) return null;

    const textAfter = textOf(change, document);
    const inMath = auto.some((m) => m.snippet.math || m.snippet.nonmath)
      ? this.isMathAt(document, caretOffset, languageId, change.text)
      : false;
    const candidates = this.contextCandidates(
      auto,
      true,
      inMath
    );
    if (!candidates.length) return null;

    const candidate = candidates[0];
    // The expansion is laid out against the document it is about to live in, not
    // against the buffer the trigger was typed into: its tab stops are positions
    // in the text *after* the trigger has been replaced, and a document that
    // still holds the trigger answers every one of them clamped to a line that no
    // longer exists.
    const insertOffset = offsetFromPosition(textAfter, candidate.range.start);
    // The matched range ends at the caret; only a multi-line regex trigger can
    // end anywhere else, and that one is counted out of the text.
    const replaceEnd = candidate.range.end.isEqual(mainChangePosition)
      ? caretOffset
      : offsetFromPosition(textAfter, candidate.range.end);

    const expansion = this.expand(candidate, { doc: docAfterInsertion ?? document, text: textAfter });
    // The expansion is laid out, so its document can be told what the buffer will
    // actually contain: the snippet with its markup resolved. Until this call the
    // instance's ranges are post-insertion positions but its document still holds
    // the trigger, and reading a tab stop out of it returns whatever the trigger
    // happened to have at that offset.
    this.setExpansionDocumentText(
      expansion,
      textAfter.slice(0, insertOffset) + expansion.plainText + textAfter.slice(replaceEnd)
    );
    return {
      candidate,
      range: candidate.range,
      insertOffset,
      replaceEnd,
      expansion,
      text: expansion.plainText
    };
  }

  // -------------------------------------------------------------------------
  // Expansion
  // -------------------------------------------------------------------------

  /**
   * Reference `expandSnippet`: build an instance for the completion, delete the
   * matched trigger and insert the snippet text. The caller applies
   * `candidate.range -> expansion.plainText`; this method owns the instance and
   * the tab-stop stack.
   */
  expand(candidate: SnippetExpansionCandidate, options: ExpandOptions = {}): SnippetExpansion {
    const text = options.text ?? (options.doc ? safeText(options.doc) : '');
    // A document of this expansion's own. The ported instance keeps a reference
    // to the document it is constructed with for the whole of the expansion's
    // life and reads it whenever it has to translate a position, so it must not
    // be the caller's snapshot of the buffer: that snapshot is the text *before*
    // the snippet was inserted, and every tab stop would be answered against a
    // line the trigger used to occupy. `options.doc` is therefore only the
    // starting point; the engine owns what the instance reads from here on.
    const editable = createEditableDocument(text, options.languageId ?? 'latex');
    const document = createTextDocumentAdapter(editable.document);

    const instance = new SnippetExpansion(
      this.scriptingAllowed() ? candidate.snippet : withoutSnippetCode(candidate.snippet),
      document,
      candidate.range.start,
      candidate.matchGroups,
      {
        document,
        editor: options.editor,
        // Pass this engine's own workspace URI explicitly: `setSnippetHost` is
        // module-global, so the ported fallback could belong to another engine.
        workspaceUri: options.workspaceUri ?? this.workspaceUriProvider?.() ?? '',
        visual: options.selection ?? this.selectionProvider?.()
      }
    );

    // Remember the source text so `getGeometry` can translate part positions
    // into plain offsets without needing a live buffer, and the knob that keeps
    // the document the instance reads in step with it.
    this.expansionRecords.set(instance, { text });
    this.expansionDocuments.set(instance, editable.setText);

    // The ported instance re-reads placeholder text from `this.document` when it
    // regenerates a code block, and the engine replaces that document's text as
    // the buffer moves, so the adapter is already reading the current buffer
    // rather than the snapshot the expansion was built from.

    if (options.pushToStack !== false && instance.selectedPlaceholder != 0) {
      this.stack.unshift(instance);
    }
    // Announced last, so a listener that reads the instance sees it fully built
    // and already on the tab-stop stack. A listener must not throw into an
    // expansion: this is observation, not part of building one.
    try {
      this.expansionListener?.(candidate, instance);
    } catch {
      /* the history is a convenience; it must not break an expansion */
    }
    return instance;
  }

  /** Installs the expansion listener; `null` removes it. */
  setExpansionListener(
    listener: ((candidate: SnippetExpansionCandidate, expansion: SnippetExpansion) => void) | null
  ): void {
    this.expansionListener = listener;
  }

  /**
   * Eukolia addition: make an expansion the active tab-stop target.
   *
   * Used by editors that build the expansion while rendering completions
   * (`expand(candidate, { …, pushToStack: false })`) and only want tab-stop
   * navigation once the user accepts one.
   */
  pushExpansion(instance: SnippetExpansion): void {
    if (instance.selectedPlaceholder == 0) return;
    this.stack.unshift(instance);
  }

  /**
   * Eukolia addition: the adapter calls this after it applied an edit, so the
   * ported instance's ranges (already translated by `SnippetExpansion.update`)
   * are interpreted against the new buffer text, anchored where the snippet
   * actually landed.
   */
  setExpansionDocumentText(instance: SnippetExpansion, text: string): void {
    this.expansionRecords.set(instance, { text });
    this.expansionDocuments.get(instance)?.(text);
  }

  /**
   * Eukolia addition: adopt an edit the *host editor* made to the buffer.
   *
   * `SnippetExpansion` keeps its own ranges in the coordinates of the buffer it
   * was laid out in, so an edit made through the editor has to move them or
   * every later question — which text the current tab stop covers, where the
   * next one is — is answered against positions that no longer exist.
   *
   * The text is handed over in the same breath, and *before* the ranges are
   * translated, because the two are halves of one fact. `update` rewrites the
   * instance's ranges into the post-edit document, while {@link getGeometry}
   * converts them back to offsets through the text recorded here; a text left
   * one edit behind turns a range that is right into an offset that is wrong,
   * which is what put the caret past the end of an expansion instead of on its
   * next placeholder.
   *
   * `changes` are in *pre-edit* coordinates, which is what CodeMirror reports and
   * what `SnippetExpansion.update` expects.
   */
  applyExpansionEdit(
    instance: SnippetExpansion,
    changes: readonly vscode.TextDocumentContentChangeEvent[],
    textAfter: string
  ): void {
    this.expansionDocuments.get(instance)?.(textAfter);
    this.expansionRecords.set(instance, { text: textAfter });
    // Where the expansion begins in the document the changes are expressed in:
    // the post-edit text, since that is what the record now holds.
    const origin = offsetFromPosition(textAfter, instance.range.range.start);
    instance.update(changes, origin);
  }

  /**
   * Reference `hsnips.nextPlaceholder`. Returns the expansion that now owns the
   * cursor, or `null` when the snippet finished and was popped.
   */
  nextTabStop(): SnippetExpansion | null {
    const top = this.stack[0];
    if (!top) return null;
    if (top.nextPlaceholder()) return top;
    // The snippet finished with this move; it leaves the stack, but the caller
    // still has to be told which expansion it has just moved onto `$0`.
    this.stack.shift();
    return top;
  }

  /**
   * Eukolia addition: whether the expansion on top of the stack has a tab stop
   * after the one it is on.
   *
   * This is what tells "the snippet is moving me on" apart from "the snippet is
   * finishing", which the caller needs *before* it advances — once
   * {@link nextTabStop} has run, an expansion that finished is gone and there is
   * nothing left to ask.
   */
  hasMoreTabStops(): boolean {
    return (this.stack[0]?.placeholderIds.indexOf(this.stack[0].selectedPlaceholder) ?? -1) <
      (this.stack[0]?.placeholderIds.length ?? 0) - 1;
  }

  /**
   * Eukolia addition: whether the expansion on top of the stack has a tab stop
   * *before* the one it is on.
   *
   * The mirror of {@link hasMoreTabStops}, and it exists for the same reason: the
   * caller has to know whether Shift-Tab has somewhere to go *before* it moves,
   * because the ported `prevPlaceholder` reports "nowhere" by dropping the
   * expansion — which abandons a snippet the author is still filling in.
   */
  hasEarlierTabStops(): boolean {
    return (this.stack[0]?.placeholderIds.indexOf(this.stack[0].selectedPlaceholder) ?? 0) > 0;
  }

  /** Reference `hsnips.prevPlaceholder`. */
  previousTabStop(): SnippetExpansion | null {
    const top = this.stack[0];
    if (!top) return null;
    if (!top.prevPlaceholder()) this.stack.shift();
    return this.stack[0] ?? null;
  }

  /** Reference `onDidChangeTextDocument` forwarding to the top instance. */
  updateActiveExpansion(changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
    const top = this.stack[0];
    if (top) top.update(changes);
  }

  /** Reference `onDidChangeTextEditorSelection`: drop expansions left behind. */
  trimStackForSelection(selection: vscode.Range): void {
    while (this.stack.length) {
      if (this.stack[0].range.contains(selection)) break;
      this.stack.shift();
    }
  }

  /**
   * Eukolia addition: absolute geometry for an expansion so an editor adapter can
   * render tab stops without re-deriving the reference's offset arithmetic.
   *
   * `from` starts at the reference's insertion point (`completion.range.start`)
   * and follows the instance as edits are applied, so the numbers stay valid as
   * long as the buffer text is kept in sync — which is what
   * {@link applyExpansionEdit} and {@link setExpansionDocumentText} are for.
   */
  getGeometry(instance: SnippetExpansion, offset = 0): ExpansionGeometry {
    const sourceText = this.expansionRecords.get(instance)?.text ?? '';
    const text = instance.plainText;
    const origin = offsetFromPosition(sourceText, instance.range.range.start) + offset;
    // How far the expansion reaches comes from the instance's own running length
    // rather than from `plainText`, which is a snapshot of what first landed in
    // the buffer: typing into a tab stop makes the expansion longer or shorter,
    // and the parts' offsets are expressed in the same running coordinate system.
    // `offset` is already inside `origin`, so it is not applied again here.
    const relativeEnd = Math.max(instance.currentLength, 0) || text.length;
    const from = origin;
    const to = origin + relativeEnd;

    const placeholders: PlaceholderLocation[] = [];
    instance.parts.forEach((part, partIndex) => {
      if (part.id === undefined) return;
      // The offsets come from where the part sits in the expansion's own text — a
      // value fixed when the expansion was built — rather than from the part's
      // document range. A range is a value that moves, and the ported `update`
      // does not grow the placeholder that was just filled, so one taken from it
      // reports a position that no longer holds what the part holds. That is what
      // put the caret beside the next tab stop instead of on it.
      //
      // The empty last part is the final cursor, and it belongs at the end of the
      // expansion whatever its recorded offset says — that is what `$0` means, the
      // place the snippet finishes, and a marker written where the tab stop before
      // it ends is indistinguishable, by offset alone, from that tab stop's own
      // end. It has to be `$0` specifically: an *ordinary* stop with an empty
      // default is empty in exactly the same way, and treating it as the final
      // cursor put the caret after the snippet's closing brace — `\part{}|`
      // instead of `\part{|}`, `\begin{align}…\end{align}|` instead of the empty
      // line inside it — for every body whose last stop is empty, which is most of
      // the shipped ones.
      const atEnd =
        part.id === 0 && partIndex === instance.parts.length - 1 && part.content.length === 0;
      const relativeFrom = atEnd ? relativeEnd : clamp(part.plainOffset, 0, relativeEnd);
      const relativeTo = atEnd
        ? relativeEnd
        : clamp(part.plainOffset + part.content.length, 0, relativeEnd);
      placeholders.push({
        id: part.id,
        from: relativeFrom,
        to: relativeTo,
        documentFrom: origin + relativeFrom,
        documentTo: origin + relativeTo,
        partIndex
      });
    });

    const selectedIds = new Set(instance.selectedParts().map((p) => p.id));
    return {
      text,
      from,
      to,
      selected: placeholders.filter((p) => p.id !== undefined && selectedIds.has(p.id)),
      placeholders
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The text a snippet inserts, worked out without building an expansion.
 *
 * `tryAutomaticExpansion` needs it *before* the expansion exists, because it is
 * what the expansion's own document is made of: the tab stops are positions in
 * the buffer the snippet lands in, and the only buffer that can answer for them
 * is the one with the trigger already replaced. The body a `.hsnips` source
 * carries *is* that text, which is why reading it back and rendering it is the
 * same string the expansion will produce.
 */
function renderSnippetBody(snippet: HSnippet): string {
  return renderBody(getSnippetBody(snippet));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * The same snippet with every code block replaced by a report.
 *
 * `snippets.allowJavaScript` off is a promise that backtick code does not run,
 * and the ported instance is the only thing that runs it: it calls the parser's
 * generator when it is built and again whenever a tab stop changes. Masking the
 * generator is therefore the whole of the switch — the snippet still expands, its
 * literal text and tab stops are untouched, and each code block contributes
 * nothing while the reason reaches the author through the warning sink (the
 * instance already reports a generator that throws).
 *
 * A copy rather than a change to the snippet itself: the library is shared with
 * the settings editor, which has to keep showing the body as written.
 */
function withoutSnippetCode(snippet: HSnippet): HSnippet {
  return Object.assign(Object.create(Object.getPrototypeOf(snippet) as object), snippet, {
    generator: () => {
      throw new Error('JavaScript in snippets is switched off in Settings');
    }
  });
}

function safeText(doc: DocumentLike): string {
  try {
    return doc.getText();
  } catch {
    return '';
  }
}

/**
 * The buffer a change produced, as text.
 *
 * `change.textAfter` may be a lazy getter (the CodeMirror host uses one), so
 * reading it here is what materialises the document — and reading it more than
 * once per decision is avoided for the same reason. A host that supplies no text
 * at all is answered from its document.
 */
function textOf(change: SnippetDocumentChange, document?: DocumentLike): string {
  if (typeof change.textAfter === 'string') return change.textAfter;
  return document ? safeText(document) : '';
}

/** The document a change produced, when the caller did not supply one. */
function createStringDocumentFrom(change: SnippetDocumentChange, languageId: string): DocumentLike {
  return createStringDocument(textOf(change), languageId);
}

function languageFromName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? name;
  return base.replace(/\.[^.]+$/, '').toLowerCase() || 'all';
}

/**
 * A line's visible end: where its text stops, before the break that ends it.
 *
 * `\r\n` is one break of two characters, and the `\r` belongs to the break rather
 * than to the line. A lone `\r` is ordinary text — CodeMirror normalises line
 * separators, so the only breaks a buffer can contain are `\n` and `\r\n`, and
 * treating a stray `\r` as a break would make an offset and the position it came
 * from disagree.
 */
function lineEnd(text: string, start: number): number {
  const next = text.indexOf('\n', start);
  if (next === -1) return text.length;
  return next > start && text.charCodeAt(next - 1) === 13 ? next - 1 : next;
}

function lineStartOffset(text: string, line: number): number {
  if (line <= 0) return 0;
  let offset = 0;
  for (let at = 0; at < line; at++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return offset;
}

export function offsetFromPosition(text: string, position: vscode.Position): number {
  const start = lineStartOffset(text, Math.max(0, position.line));
  if (start >= text.length) return text.length;
  const end = lineEnd(text, start);
  return start + clamp(position.character, 0, Math.max(0, end - start));
}

export function positionFromOffset(text: string, offset: number): vscode.Position {
  const target = clamp(Math.max(0, offset), 0, text.length);
  let line = 0;
  let start = 0;
  for (;;) {
    const end = lineEnd(text, start);
    if (target <= end) return new vscode.Position(line, target - start);
    const next = text.indexOf('\n', start);
    if (next === -1) return new vscode.Position(line, end - start);
    // The target names the break itself (the `\n`, or the `\r` of a `\r\n`),
    // which no position can point at: the caret belongs at the end of the line
    // the break closes.
    if (target <= next) return new vscode.Position(line, end - start);
    line += 1;
    start = next + 1;
  }
}

/**
 * Where the caret sits after `text` is inserted at `position`.
 *
 * Exact for an insertion, and the automatic path only ever responds to one
 * (`change.text.length == 1`), so a typed character does not have to be located
 * by splitting the whole document to find out which line the caret is on.
 */
export function positionAfterInsertion(position: vscode.Position, text: string): vscode.Position {
  const newline = text.lastIndexOf('\n');
  if (newline === -1) return position.translate(0, text.length);
  let extraLines = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') extraLines++;
  return new vscode.Position(position.line + extraLines, text.length - newline - 1);
}

export { stripPlaceholders };
