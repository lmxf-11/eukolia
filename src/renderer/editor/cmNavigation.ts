/**
 * Eukolia — LaTeX navigation for CodeMirror 6.
 *
 * Code Mode and Visual Mode are being unified on one CodeMirror 6 surface, which
 * retires Monaco. Three features used to exist *only* as Monaco language
 * providers in `monacoLatex.ts`: go to definition, find all references, and
 * clickable document links for `\input`-style paths and URLs. This module carries
 * all three over, with the same resolution rules and the same fallbacks.
 *
 * The LaTeX intelligence still comes from Eukolia's own services: `completion.ts`
 * decides which command's argument the caret is in and what kind of argument it
 * is, and `projectIndex` decides where that argument points. Nothing here reads a
 * setting.
 *
 * Positions are always derived from the editor's `Text` and clamped to the
 * document, so a malformed document — an unclosed `{`, a stale offset, a link
 * range past the end — resolves to "nothing found" rather than throwing.
 */

import { type Extension, type Range, type Text } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate
} from '@codemirror/view';
import { analyzeCompletionContext, argumentKind, type CompletingArgument } from './completion';
import { projectIndex } from '../document/projectIndex';
import { isMac } from '../vendor/overleaf/eukolia/os';

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/**
 * What the editor cannot do for itself: open a file and show a result list.
 *
 * The navigation module owns *resolution* (which file a `\ref` names, whether a
 * path exists in the project) and the host owns everything the shell has to do
 * about it, so the extension stays usable in both editor modes and in tests.
 */
export interface LatexNavigationHost {
  /** Open a project file, optionally at a 1-based line and column. */
  openFile(path: string, line?: number, column?: number): void;
  /** Show the occurrences found by Find All References. */
  showReferences(label: string, occurrences: ReadonlyArray<{ file: string; line: number }>): void;
}

// ---------------------------------------------------------------------------
// Shared resolution
// ---------------------------------------------------------------------------

/** Extensions a path written in a source-taking command may carry. */
const SOURCE_FILE_EXTENSIONS = ['tex', 'ltx', 'sty', 'bib'] as const;
/** Extensions a path written in `\includegraphics` may carry. */
const GRAPHICS_FILE_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'eps', 'svg'] as const;

/**
 * The extensions a file-taking command's path argument may carry.
 *
 * `\includegraphics` names a picture; every other file-taking command names a
 * source or bibliography file. The two lists must stay apart: a project holding
 * both `figures/plot.png` and `figures/plot.tex` would otherwise resolve
 * `\includegraphics{figures/plot}` to the TeX file.
 */
export function fileExtensionsFor(command: string): readonly string[] {
  return command === 'includegraphics' ? GRAPHICS_FILE_EXTENSIONS : SOURCE_FILE_EXTENSIONS;
}

/** The command whose argument the caret at `offset` is in, if any. */
function argumentAt(text: string, offset: number, uri: string): CompletingArgument | null {
  return analyzeCompletionContext(text, clampOffset(offset, text.length), uri).argument;
}

/**
 * An argument's text without its braces.
 *
 * An unclosed argument runs to the end of the document, where the last character
 * is not part of the argument and `to - 1` therefore drops it — the Monaco
 * providers' behaviour. Clamping keeps that slice from being inverted by a
 * malformed document.
 */
function argumentText(text: string, argument: CompletingArgument): string {
  const from = Math.min(argument.from + 1, text.length);
  const to = Math.max(from, Math.min(argument.to - 1, text.length));
  return text.slice(from, to).trim();
}

/**
 * Clamps an offset to `[0, length]`.
 *
 * `NaN` and anything outside the document collapse to the nearest real position,
 * so no resolver has to guard against a stale offset of its own.
 */
function clampOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(Math.floor(offset), length));
}

/** `clampOffset` against a CodeMirror document. */
function clampToDocument(offset: number, doc: Text): number {
  return clampOffset(offset, doc.length);
}

/** The 1-based line `offset` falls on in plain text. */
function lineAtOffset(text: string, offset: number): number {
  return text.slice(0, clampOffset(offset, text.length)).split('\n').length;
}

/**
 * Escapes a label for use inside a regular expression.
 *
 * `monacoLatex.ts` kept this helper private, so the port carries its own copy —
 * character for character, so the reference pattern matches exactly what it
 * matched before. (LaTeX Workshop's `escapeRegExp` escapes a wider set; it is
 * not used here to keep the pattern identical to the one being ported.)
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Go to definition
// ---------------------------------------------------------------------------

/** Where a navigation target points. */
export interface NavigationTarget {
  /** Absolute path of the file to open. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
}

/**
 * The definition of the symbol the caret at `offset` is on, or `null`.
 *
 * Three cases resolve, and each falls through to nothing rather than on to the
 * next one:
 *
 * - `\ref`/`\eqref`/… and `\label` → the first labelled occurrence of the name;
 * - `\input`/`\include`/… and `\includegraphics` → the first file candidate,
 *   opened at the top;
 * - `\newcommand`/`\renewcommand`/`\providecommand` → the macro's definition,
 *   matched on the command name because `argumentKind` has no entry for it.
 *
 * `uri` is only forwarded to `analyzeCompletionContext`, which records it in the
 * context; no resolution rule reads it.
 */
export function resolveDefinition(text: string, offset: number, uri = ''): NavigationTarget | null {
  const argument = argumentAt(text, offset, uri);
  if (!argument) return null;

  const kind = argumentKind(argument.name);
  const name = argumentText(text, argument);

  if (kind === 'reference' || kind === 'label') {
    const target = projectIndex.getLabelOccurrences(name)[0];
    if (!target) return null;
    return { file: target.file, line: target.line, column: 1 };
  }

  if (kind === 'file') {
    const target = projectIndex.resolveReference(name, fileExtensionsFor(argument.name));
    if (!target) return null;
    // A file has no definition inside it, so the top of it is the target.
    return { file: target.path, line: 1, column: 1 };
  }

  if (argument.name === 'newcommand' || argument.name === 'renewcommand' || argument.name === 'providecommand') {
    const match = /^\\([A-Za-z@]+)/.exec(name);
    const macro = match ? projectIndex.getMacro(match[1]) : undefined;
    if (macro) return { file: macro.file, line: macro.line, column: 1 };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Find all references
// ---------------------------------------------------------------------------

/** One place a label is used. */
export interface ReferenceOccurrence {
  /** Absolute path of the file. */
  file: string;
  /** 1-based line. */
  line: number;
}

/** The result of a reference search: the label and every occurrence of it. */
export interface ReferenceSearch {
  /** The label the search was for. */
  label: string;
  /** Every occurrence, de-duplicated, in project order. */
  occurrences: ReferenceOccurrence[];
}

/** The commands that reference a label, as the Monaco provider listed them. */
const REFERENCE_COMMANDS = 'ref|eqref|pageref|autoref|cref|Cref|vref|label';

/**
 * Every occurrence of the label the caret at `offset` is on, or `null` when the
 * caret is not in a label argument.
 *
 * Two halves, as before: the labels the project index found (the definition, and
 * any `\label` the analyzer recorded), then every document's text scanned for a
 * command that refers to the label. The index is the authority on order, so the
 * result is stable; a repeat of the same file and line is reported once.
 */
export function findReferences(text: string, offset: number, uri = ''): ReferenceSearch | null {
  const argument = argumentAt(text, offset, uri);
  if (!argument || argumentKind(argument.name) !== 'label') return null;

  const label = argumentText(text, argument);
  const seen = new Set<string>();
  const occurrences: ReferenceOccurrence[] = [];
  const add = (file: string, line: number): void => {
    const key = `${file}\u0000${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    occurrences.push({ file, line });
  };

  for (const occurrence of projectIndex.getLabelOccurrences(label)) {
    add(occurrence.file, occurrence.line);
  }

  // Every document is scanned as written text rather than through the index's
  // symbol lists: a `\ref` in a file the index has no symbols for is still an
  // occurrence, and the pattern also covers the label's own definition.
  const regexp = new RegExp(`\\\\(?:${REFERENCE_COMMANDS})\\{${escapeRegExp(label)}\\}`, 'g');
  for (const document of projectIndex.getAllDocuments()) {
    const documentText = document.getText();
    regexp.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regexp.exec(documentText)) !== null) {
      add(document.uri, lineAtOffset(documentText, match.index));
    }
  }

  return { label, occurrences };
}

// ---------------------------------------------------------------------------
// Document links
// ---------------------------------------------------------------------------

/** A run of text that names a file or a URL, exactly as it was written. */
export interface DocumentLink {
  /** Offset of the first character of the link. */
  from: number;
  /** Offset just past the last character of the link. */
  to: number;
  /** Whether the link names a project file or an external URL. */
  kind: 'file' | 'url';
  /** What the range covers: an argument's contents, or the URL itself. */
  text: string;
  /** The command that wrote the argument; empty for a URL. */
  command: string;
}

/** A document link with its target resolved. */
export interface ResolvedDocumentLink extends DocumentLink {
  /** Absolute path of the project file, when a file link resolved. */
  path: string | null;
  /** The URL to open, when this is an external link. */
  url: string | null;
  /** What hovering the link shows. */
  tooltip: string;
  /** False when the link resolves to nothing, and must not look clickable. */
  clickable: boolean;
}

/**
 * Every file reference and URL in `text`.
 *
 * A file link's range covers the argument's contents only — the path inside the
 * braces, not the command, an optional `[...]` group, or the braces themselves —
 * which is what makes it clickable without dragging the surrounding source into
 * the link. Whitespace-only arguments are not links at all.
 */
export function scanDocumentLinks(text: string): DocumentLink[] {
  const links: DocumentLink[] = [];

  const fileRegexp = /\\(input|include|subfile|includegraphics|bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = fileRegexp.exec(text)) !== null) {
    const argument = match[2];
    if (!argument.trim()) continue;
    // The argument is the tail of the match minus its closing brace, so its last
    // occurrence inside the match is its own position: an optional `[...]` group
    // between the command and the brace cannot widen the range.
    const from = match.index + match[0].lastIndexOf(argument);
    links.push({ from, to: from + argument.length, kind: 'file', text: argument, command: match[1] });
  }

  const urlRegexp = /(https?:\/\/[^\s{}]+)/g;
  while ((match = urlRegexp.exec(text)) !== null) {
    links.push({ from: match.index, to: match.index + match[1].length, kind: 'url', text: match[1], command: '' });
  }

  return links;
}

/**
 * Resolves each link against the project, clamping its range to the document.
 *
 * A URL is its own target. A file link resolves through the same candidate
 * search go-to-definition uses, and when nothing matches it stays in the list —
 * so it can still explain itself on hover — but reports `clickable: false`, so
 * an unresolvable path never looks like something that can be opened.
 */
export function resolveDocumentLinks(links: readonly DocumentLink[], docLength: number): ResolvedDocumentLink[] {
  return links.map((link) => {
    const from = clampOffset(link.from, docLength);
    const range = { from, to: Math.max(from, clampOffset(link.to, docLength)) };

    if (link.kind === 'url') {
      return { ...link, ...range, path: null, url: link.text, tooltip: link.text, clickable: true };
    }

    const target = projectIndex.resolveReference(link.text, fileExtensionsFor(link.command));
    if (!target) {
      return { ...link, ...range, path: null, url: null, tooltip: `File not found: ${link.text}`, clickable: false };
    }
    return { ...link, ...range, path: target.path, url: null, tooltip: target.relativePath, clickable: true };
  });
}

// ---------------------------------------------------------------------------
// The CodeMirror extension
// ---------------------------------------------------------------------------

/** The class a resolved file or URL range carries. */
export const DOCUMENT_LINK_CLASS = 'cm-eukolia-document-link';
/** The class an unresolvable path carries, so it never looks clickable. */
export const MISSING_DOCUMENT_LINK_CLASS = 'cm-eukolia-document-link-missing';

/**
 * The link whose half-open range covers `offset`, if any.
 *
 * Half-open, because that is how the decorations are drawn: the character under
 * the pointer is the one at `from`, and the character after the link is not part
 * of it.
 */
export function linkAtOffset(links: readonly ResolvedDocumentLink[], offset: number): ResolvedDocumentLink | null {
  return links.find((link) => offset >= link.from && offset < link.to) ?? null;
}

/** Characters decorated beyond the viewport, so a short scroll does not flash. */
const VIEWPORT_MARGIN = 500;

/**
 * Links are painted with the application's own link colour rather than a
 * CodeMirror theme colour, so they read the same in either editor mode and in
 * every theme. A missing file keeps the document's own colour and cursor: it has
 * a tooltip, but no click.
 */
const documentLinkTheme = EditorView.baseTheme({
  [`.${DOCUMENT_LINK_CLASS}`]: {
    color: 'var(--eu-fg-link, #6aa6ff)',
    textDecoration: 'underline',
    cursor: 'pointer'
  },
  [`.${MISSING_DOCUMENT_LINK_CLASS}`]: {
    color: 'inherit',
    textDecoration: 'none',
    cursor: 'text'
  }
});

/** Opens an external URL in the user's browser, through the preload bridge. */
function openExternal(url: string): void {
  // The same call the PDF viewer's link layer makes. The bridge is absent
  // outside Electron, where there is no browser to hand the URL to.
  const api = typeof window === 'undefined' ? undefined : window.eukoliaApi;
  if (!api) return;
  void api.openExternal(url);
}

/**
 * Decorates the document's links and follows the one that is clicked.
 *
 * Only the visible ranges are decorated (plus a margin), but every resolved link
 * is kept, so a click is answered from the whole document rather than from what
 * happens to be on screen.
 */
class DocumentLinks implements PluginValue {
  /** Every resolved link in the document, on screen or not. */
  links: ResolvedDocumentLink[] = [];
  decorations: DecorationSet = Decoration.none;

  constructor(private readonly view: EditorView, private readonly host: LatexNavigationHost) {
    this.resolve();
    this.decorate();
  }

  update(update: ViewUpdate): void {
    // Only a changed document can change what the links resolve to; a scroll
    // only changes which of them are painted.
    if (update.docChanged) this.resolve();
    if (update.docChanged || update.viewportChanged) this.decorate();
  }

  /** The link whose range covers `offset`, if any. */
  linkAt(offset: number): ResolvedDocumentLink | null {
    return linkAtOffset(this.links, offset);
  }

  /**
   * Opens the link under `event`, and reports whether it was consumed — which is
   * what stops CodeMirror from also placing the caret inside the link's text.
   */
  follow(event: MouseEvent, view: EditorView): boolean {
    if (event.button !== 0) return false;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null) return false;

    const link = this.linkAt(clampToDocument(position, view.state.doc));
    if (!link || !link.clickable) return false;

    event.preventDefault();
    if (link.url) openExternal(link.url);
    else if (link.path) this.host.openFile(link.path);
    return true;
  }

  /** Resolves every link in the document, whether or not it is on screen. */
  private resolve(): void {
    const doc = this.view.state.doc;
    this.links = resolveDocumentLinks(scanDocumentLinks(doc.toString()), doc.length);
  }

  /** Paints the visible links, plus a margin so a short scroll does not flash. */
  private decorate(): void {
    const doc = this.view.state.doc;
    const ranges: Range<Decoration>[] = [];
    for (const visible of this.view.visibleRanges) {
      const from = Math.max(0, visible.from - VIEWPORT_MARGIN);
      const to = Math.min(doc.length, visible.to + VIEWPORT_MARGIN);
      for (const link of this.links) {
        if (link.to < from || link.from > to) continue;
        // A mark decoration may not be empty, and a clamped range can collapse.
        if (link.to <= link.from) continue;
        ranges.push(
          Decoration.mark({
            class: link.clickable ? DOCUMENT_LINK_CLASS : MISSING_DOCUMENT_LINK_CLASS,
            attributes: { title: link.tooltip }
          }).range(link.from, link.to)
        );
      }
    }

    this.decorations = Decoration.set(ranges, true);
  }
}

/** The document-link plugin: decorations plus the click that follows them. */
const documentLinks = (host: LatexNavigationHost): Extension =>
  ViewPlugin.define((view) => new DocumentLinks(view, host), {
    decorations: (value) => value.decorations,
    eventHandlers: {
      mousedown(event, view) {
        return this.follow(event, view);
      }
    }
  });

/** Jumps to the definition under `offset`, and reports whether there was one. */
function goToDefinitionAt(view: EditorView, host: LatexNavigationHost, offset: number): boolean {
  const target = resolveDefinition(view.state.doc.toString(), clampToDocument(offset, view.state.doc));
  if (!target) return false;
  host.openFile(target.file, target.line, target.column);
  return true;
}

/** Shows the label's references, and reports whether the caret was on a label. */
function showReferencesAt(view: EditorView, host: LatexNavigationHost): boolean {
  const doc = view.state.doc;
  const search = findReferences(doc.toString(), clampToDocument(view.state.selection.main.head, doc));
  if (!search) return false;
  host.showReferences(search.label, search.occurrences);
  return true;
}

/**
 * Go to definition, find all references, clickable file links and URLs.
 *
 * The extension owns four things: the `F12` and `Shift+F12` key bindings, the
 * `Mod`-click gesture for go to definition (`Cmd` on macOS, `Ctrl` elsewhere —
 * the platform's own secondary-click modifier is never treated as `Mod`), and
 * the link decorations. Every resolution ends in a host callback: `openFile` for
 * a definition or a file link, `showReferences` for Find All References.
 * External URLs go straight to `window.eukoliaApi.openExternal`, since the host
 * interface has no way to open one.
 */
export function latexNavigation(host: LatexNavigationHost): Extension {
  return [
    keymap.of([
      {
        key: 'F12',
        run: (view) => goToDefinitionAt(view, host, view.state.selection.main.head)
      },
      {
        key: 'Shift-F12',
        run: (view) => showReferencesAt(view, host)
      }
    ]),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0) return false;
        if (event.shiftKey || event.altKey) return false;
        if (!(isMac ? event.metaKey : event.ctrlKey)) return false;
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return false;
        if (!goToDefinitionAt(view, host, position)) return false;
        event.preventDefault();
        return true;
      }
    }),
    documentLinks(host),
    documentLinkTheme
  ];
}
