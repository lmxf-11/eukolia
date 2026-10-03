// Ported from References/hypersnips/src/hsnippetInstance.ts (MIT, (c) 2019 Ian Ornelas). Modified for Eukolia.

import * as vscode from 'vscode';
import { DynamicRange, GrowthType, IChangeInfo } from './dynamicRange';
import { applyOffset } from './utils';
import { HSnippet, GeneratorResult } from './hsnippet';

/**
 * Eukolia modification — editor-agnostic seams.
 *
 * The reference module was bound to VS Code in three places:
 *   1. a module-level `vscode.window.onDidChangeTextEditorSelection` listener
 *      that cached `$VISUAL`/`${VISUAL}` selection text,
 *   2. `vscode.TextEditor` as the edit surface,
 *   3. `vscode.window.showWarningMessage` for generator failures.
 * All three are now injected, so `hsnippetInstance` no longer needs a live
 * VS Code host and can run head-less (tests, web worker, Monaco adapter).
 */
export interface TextDocumentLike {
  lineCount?: number;
  getText(range?: vscode.Range): string;
  lineAt(line: number | vscode.Position): { text: string; firstNonWhitespaceCharacterIndex: number };
  uri?: { toString(): string };
  /** Offset of a position, when the seam can answer. See `endPositionFor`. */
  offsetAt?(position: vscode.Position): number;
  /** Position of an offset, when the seam can answer. See `endPositionFor`. */
  positionAt?(offset: number): vscode.Position;
}

export interface SnippetEditorLike {
  document: TextDocumentLike;
  edit(callback: (builder: SnippetEditBuilder) => void): Promise<boolean> | boolean;
}

export interface SnippetEditBuilder {
  replace(location: vscode.Range, value: string): void;
  insert(position: vscode.Position, value: string): void;
  delete(location: vscode.Range): void;
}

export interface SnippetHost {
  /** `${VISUAL}` substitution source (`A`-flag snippets can capture a selection). */
  getSelectedText?(): { text: string; timestamp: number } | undefined;
  /** Diagnostics sink; defaults to `console.warn`. */
  warn?(message: string): void;
  /** Workspace URI handed to generators as `w`. */
  getWorkspaceUri?(): string;
  /**
   * Values for `${NAME}` / `${NAME:default}` variables, e.g. `TM_FILENAME`.
   *
   * The reference delegated these to VS Code's snippet controller, which is not
   * here to ask; the host is. A name the host does not know falls back to the
   * variable's own default, and to nothing when it has none.
   */
  getVariables?(): Record<string, string | undefined> | undefined;
}

const IDENTITY_DOCUMENT: TextDocumentLike = {
  getText: () => '',
  lineAt: () => ({ text: '', firstNonWhitespaceCharacterIndex: 0 })
};

let host: SnippetHost = {};

export function setSnippetHost(next: SnippetHost): void {
  host = next;
}

/** Reference behaviour: `${VISUAL}` is only substituted while it is fresh. */
const VISUAL_FRESHNESS_MS = 5000;

/** A single backslash, spelled out so escape-heavy code below stays readable. */
const BACKSLASH = String.fromCharCode(92);

function defaultWorkspaceUri(): string {
  try {
    return vscode.workspace.workspaceFolders?.[0]?.uri?.toString() ?? '';
  } catch {
    return '';
  }
}

function documentUri(document: TextDocumentLike): string {
  try {
    return document.uri?.toString() ?? '';
  } catch {
    return '';
  }
}

function firstNonWhitespace(document: TextDocumentLike, line: number): number {
  try {
    const lineInfo = document.lineAt(line);
    if (typeof lineInfo?.firstNonWhitespaceCharacterIndex === 'number') {
      return lineInfo.firstNonWhitespaceCharacterIndex;
    }
    return (lineInfo?.text ?? '').length - (lineInfo?.text ?? '').replace(/^\s+/, '').length;
  } catch {
    return 0;
  }
}

function textIn(document: TextDocumentLike, range: vscode.Range): string {
  try {
    return document.getText(range) ?? '';
  } catch {
    return '';
  }
}

/**
 * Eukolia addition: where `text` ends when it is written from `start`.
 *
 * Counting lines and columns by hand is wrong for a placeholder whose default
 * spans lines — and a LaTeX placeholder's default very often does, because an
 * environment body is written as one. Asking the document is both shorter and
 * correct, and every reader here has one.
 *
 * A document seam without `offsetAt`/`positionAt` (the tests' minimal stubs) can
 * still answer, because a default that stays on one line is the common case.
 */
function endPositionFor(
  document: TextDocumentLike,
  start: vscode.Position,
  text: string
): vscode.Position {
  const offsetAt = document.offsetAt?.bind(document);
  const positionAt = document.positionAt?.bind(document);
  if (!offsetAt || !positionAt) return applyOffset(start, text, 0);
  try {
    return positionAt(offsetAt(start) + text.length);
  } catch {
    return applyOffset(start, text, 0);
  }
}

/**
 * Eukolia addition: one reader for VS Code snippet markup.
 *
 * Upstream's `hsnippetInstance` matched placeholders with
 * `/\$(\d+)|\$\{(\d+)\}/` — the `TODO: Handle snippets with default content in a
 * placeholder.` in the constructor is that gap — while its own
 * `stripPlaceholders` understood the richer forms. The two therefore disagreed:
 * a body such as `\begin{${1:equation}}` was *inserted* with the markup intact,
 * so the document showed `${1:equation}`, even though the plain text of the same
 * snippet rendered it as `equation`. Eukolia ships snippets using that form, so
 * the engine now reads every placeholder through this one function: the inserted
 * text and the tab stops it creates come out of the same answer.
 *
 * Recognised, in the order VS Code resolves them:
 *
 *   `$1`  `${1}`            an empty tab stop
 *   `${1:default}`          a tab stop whose initial text is `default`
 *   `${1|a,b,c|}`           a choice; the initial text is the first option
 *   `${1/re/f/}`            a mirror with a transform — there is no live tab stop
 *                           to transform in a plain-text buffer, and the
 *                           transform of an empty tab stop is empty, so this
 *                           contributes no text rather than literal markup.
 *                           `${1:source/re/f/}` ``code`` names the text the
 *                           substitution is computed from — the literal
 *                           `source`, or the index itself when omitted, which is
 *                           how a substituted expression is written.
 *   `${VISUAL}`, `${VAR:x}` a variable; `stripPlaceholders` renders its default
 *                           and the constructor leaves it to the host
 *
 * `id` is absent for a variable: it is not a tab stop, so an expansion must not
 * create one for it.
 */
export interface PlaceholderToken {
  /** The whole token, e.g. `${1:equation}`. */
  token: string;
  /** Placeholder number, or absent when the token is not a tab stop. */
  id?: number;
  /** Initial text, rendered exactly as `stripPlaceholders` renders it. */
  content: string;
}

export function readPlaceholder(text: string, index: number): PlaceholderToken | null {
  if (text[index] !== '$') return null;
  let slashes = 0;
  for (let b = index - 1; b >= 0 && text[b] === '\\'; b--) {
    slashes++;
  }
  if (slashes % 2 !== 0) return null;
  const rest = text.slice(index);

  const choice = /^\$\{(\d+)\|([^}]*)\|\}/.exec(rest);
  if (choice) {
    return { token: choice[0], id: Number(choice[1]), content: choice[2].split(',')[0] ?? '' };
  }

  const transform = readTransformToken(rest);
  if (transform) return { token: transform, id: Number(/^\$\{(\d+)/.exec(rest)![1]), content: '' };

  const bracedHead = /^\$\{([0-9]+|[A-Za-z_]\w*)(?:(:|\}))/.exec(rest);
  if (bracedHead) {
    const isNumeric = /^[0-9]+$/.test(bracedHead[1]);
    const id = isNumeric ? Number(bracedHead[1]) : undefined;
    const sep = bracedHead[2];
    if (sep === '}') {
      return { token: rest.slice(0, bracedHead[0].length), id, content: '' };
    }
    // sep === ':': default text follows. Scan balanced braces until matching closing brace.
    let depth = 1;
    let cursor = bracedHead[0].length;
    while (cursor < rest.length) {
      const char = rest[cursor];
      if (char === '\\' && cursor + 1 < rest.length) {
        if (rest[cursor + 1] === '}' && depth > 1) {
          depth -= 1;
          cursor += 2;
          continue;
        }
        cursor += 2;
        continue;
      }
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const token = rest.slice(0, cursor + 1);
          const content = rest.slice(bracedHead[0].length, cursor);
          return { token, id, content };
        }
      }
      cursor += 1;
    }
  }

  const numeric = /^\$(\d+)/.exec(rest);
  if (numeric) {
    return { token: numeric[0], id: Number(numeric[1]), content: '' };
  }

  return null;
}

/**
 * Eukolia modification: read a substitution without mangling it.
 *
 * A substitution is `/find/replace/flags` written inside `${…}`, and the reader
 * used to cut it off at the first `}` and treat everything from the first `/`
 * after the index as the substitution. Both were wrong for bodies the format
 * allows: `/[0-9]{2}/X/` ends at the `}` of its own quantifier, and a
 * substitution written around a code block — `` `${1/x/y/}`rv = …`` `` — is the
 * form `snippets/eusnips/body.ts` writes for a substituted expression, which the
 * old reader matched as a plain `${1}` and left the rest as text.
 *
 * The scan is segment-aware: `find` may hold an escaped or character-class slash
 * (`/a\/b/`, `/[a/b]/`), `replace` runs to the next unescaped slash, and the
 * flags run to the end of the group. Nothing is validated, because whether the
 * pattern compiles is the snippet author's business; the reader's contract is
 * only that it recognises the shape and reports where it ends.
 */
function readTransformToken(rest: string): string | null {
  if (!/^\$\{\d+\//.test(rest)) return null;

  let cursor = rest.indexOf('/') + 1;
  let inClass = false;
  for (;;) {
    if (cursor >= rest.length) return null;
    const character = rest[cursor];
    if (character === '\\' && cursor + 1 < rest.length) {
      cursor += 2;
      continue;
    }
    if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (character === '/' && !inClass) {
      cursor += 1;
      break;
    }
    cursor += 1;
  }

  for (;;) {
    if (cursor >= rest.length) return null;
    const character = rest[cursor];
    if (character === '\\' && cursor + 1 < rest.length) {
      cursor += 2;
      continue;
    }
    if (character === '/') {
      cursor += 1;
      break;
    }
    cursor += 1;
  }

  while (cursor < rest.length && rest[cursor] !== '}') cursor += 1;
  if (cursor >= rest.length) return null;
  return rest.slice(0, cursor + 1);
}

export enum HSnippetPartType {
  Placeholder,
  Block,
}

/**
 * Eukolia addition: where `content` begins in `plain`, at or after `hint`.
 *
 * `hint` is what the assembly alongside the snippet string worked out, and it is
 * right in every ordinary case. It only has to be recovered when capture groups
 * were substituted into the body, because then the text the parts were laid out
 * against is not the text that was inserted. The hint keeps the search from
 * matching an identical earlier fragment, so a body that repeats a word still
 * places its tab stops where they belong.
 */
function plainOffsetOf(plain: string, content: string, hint: number): number {
  const found = plain.indexOf(content, Math.max(0, Math.min(hint, plain.length)));
  if (found >= 0) return found;
  const earlier = plain.indexOf(content);
  return earlier >= 0 ? earlier : Math.max(0, Math.min(hint, plain.length));
}

export class HSnippetPart {
  type: HSnippetPartType;
  range: DynamicRange;
  content: string;
  id?: number;
  updates: IChangeInfo[];
  /**
   * Eukolia addition: where this part's content begins in the expansion's
   * `plainText`.
   *
   * `plainText` is built once and never changes — the parts are the generator's
   * output, and what the author types goes *into* a part rather than replacing
   * the expansion — so this is a fixed, exact answer to "where is this tab stop
   * in the text that was inserted?". Deriving it from the document ranges
   * instead means deriving it from a value that moves: a range whose end is
   * recomputed from a filled placeholder's content drifts by the length of what
   * was typed, and Tab then lands beside the next tab stop rather than on it.
   */
  plainOffset = 0;
  parentId?: number;
  children: number[] = [];

  constructor(type: HSnippetPartType, range: DynamicRange, content: string, id?: number) {
    this.type = type;
    this.range = range;
    this.content = content;
    this.id = id;
    this.updates = [];
    this.children = [];
  }

  updateRange() {
    if (this.updates.length == 0) return;
    this.range.update(this.updates);
    this.updates = [];
  }
}

export interface SnippetExpansionOptions {
  /** Document the expansion is written into. Defaults to an empty document. */
  document?: TextDocumentLike;
  /** Live edit surface. When absent the expansion is computed only. */
  editor?: SnippetEditorLike;
  /** Workspace URI handed to generator code blocks as `w`. */
  workspaceUri?: string;
  /** Selection text used for `${VISUAL}`, defaults to the installed `SnippetHost`. */
  visual?: { text: string; timestamp: number };
}
/**
 * Eukolia addition: `${VISUAL}` and `${VISUAL:default}` in one pass.
 *
 * The selection wins when there is one (a fresh snapshot, which the caller has
 * already established); otherwise the default text is used, and with neither the
 * variable disappears — which is what the reference did with the bare form.
 */
export function replaceVisual(text: string, selection: string): string {
  if (!text.includes('${VISUAL')) return text;
  let result = '';
  let at = 0;
  const marker = '${VISUAL';
  for (;;) {
    const start = text.indexOf(marker, at);
    if (start === -1) break;
    // The default may contain braces of its own (`${VISUAL:\textbf{x}}`), so the
    // closing brace is the one that balances the opening one rather than the
    // first that appears.
    let depth = 0;
    let end = -1;
    for (let i = start + 1; i < text.length; i++) {
      const char = text[i];
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    const head = text.slice(start + marker.length, end);
    result += text.slice(at, start);
    if (head === '') {
      result += selection;
    } else if (head.startsWith(':')) {
      result += selection.length > 0 ? selection : head.slice(1);
    } else {
      // Something else that merely begins with the marker (`${VISUALIZE}`);
      // leave it alone rather than swallowing it.
      result += text.slice(start, end + 1);
    }
    at = end + 1;
  }
  return result + text.slice(at);
}

export class SnippetExpansion {
  type: HSnippet;
  matchGroups: string[];
  editor: SnippetEditorLike | undefined;
  document: TextDocumentLike;
  range: DynamicRange;
  placeholderIds: number[];
  selectedPlaceholder: number;
  parts: HSnippetPart[];
  blockParts: HSnippetPart[];
  blockChanged: boolean;
  snippetString: vscode.SnippetString;
  /**
   * Eukolia addition: the literal text of the expansion with placeholder markup
   * removed, i.e. what a plain-text editor should actually insert. The reference
   * relied on VS Code's `editor.action.insertSnippet` to do that resolution.
   */
  plainText: string;
  /** Eukolia addition: workspace URI captured at construction for `update()`. */
  readonly workspaceUri: string;
  /**
   * Eukolia addition: how long the expansion currently is.
   *
   * `plainText` is a snapshot of what first landed in the buffer and does not
   * change, so it cannot say how far the expansion reaches once the author has
   * typed into a tab stop. This does, and it is maintained in the same
   * coordinates as {@link HSnippetPart.plainOffset} and each part's content, so
   * the three never disagree.
   */
  currentLength = 0;

  constructor(
    type: HSnippet,
    document: TextDocumentLike,
    position: vscode.Position,
    matchGroups: string[],
    options: SnippetExpansionOptions = {}
  ) {
    this.type = type;
    this.document = document ?? IDENTITY_DOCUMENT;
    this.editor = options.editor;
    this.matchGroups = matchGroups;
    this.selectedPlaceholder = 0;
    this.placeholderIds = [];
    this.blockChanged = false;

    const workspaceUri = options.workspaceUri ?? host.getWorkspaceUri?.() ?? defaultWorkspaceUri();
    this.workspaceUri = workspaceUri;
    const fileUri = documentUri(this.document);

    // TODO, update parser so only the block that threw the error does not expand, perhaps replace
    // the block with the error message.
    //
    // Known and deliberate, with a test that pins it (`eusnipsEngine`: "reports a body
    // whose helper is still missing instead of inserting nothing"): a body that throws
    // produces an empty expansion, so the text the snippet matched is replaced by
    // nothing and the snippet surfaces as a *problem* in the manager rather than as a
    // silent no-op. Anything a reader types while a code block is broken is therefore
    // removed — the warning sink (`host.warn`, which reaches `console.warn` and the
    // application log) is the only trace outside the manager. Reported rather than
    // changed: the reporter is part of the design and three tests depend on it.
    let generatorResult: GeneratorResult = [[], []];
    try {
      // `undefined` is the generated file's unused `context` slot — the reference
      // bound Node's `require` there, Eukolia deliberately passes nothing.
      generatorResult = type.generator(
        undefined,
        // The tab stops' text, in document order. The parser recorded what each
        // one starts with, because at this point there are no parts to read it
        // from — they are built from this very call's output.
        [...(type.placeholderDefaults ?? new Array(this.type.placeholders).fill(''))],
        this.matchGroups,
        workspaceUri,
        fileUri
      );
    } catch (e) {
      if (e instanceof Error) {
        // Reference called vscode.window.showWarningMessage here; Eukolia routes
        // the diagnostic through the injected host.
        const message = `Snippet ${this.type.description} failed to expand with error: ${e.message}`;
        if (host.warn) host.warn(message);
        else console.warn(message);
      }
    }

    // For a lack of creativity, I'm referring to the parts of the array that are returned by the
    // snippet function as 'sections', and the result of the interpolated javascript in the snippets
    // are referred to as 'blocks', as in code blocks.
    let [sections, blocks] = generatorResult;
    blocks = blocks.map(String);

    this.parts = [];
    this.blockParts = [];

    let start = position;
    let snippetString = '';
    /**
     * Eukolia addition: the same text as `snippetString`, resolved as it is
     * built, so each part can record where it begins in it. See
     * {@link HSnippetPart.plainOffset}.
     */
    let plainSoFar = '';
    const indentLevel = firstNonWhitespace(this.document, position.line);

    const visual = options.visual ?? host.getSelectedText?.();
    const visualIsFresh = visual != null && Date.now() - visual.timestamp < VISUAL_FRESHNESS_MS;
    // Verbatim, deliberately. The reference escaped the selection
    // (`\\` → `\\\ `, `}` → `\}`) before splicing it in, but nothing on the way
    // out undoes that: `stripPlaceholders` keeps a backslash that precedes
    // anything but a dollar sign, because `\\`, `\{` and `\}` are LaTeX. So
    // wrapping `\begin{align}…\end{align}` in `${VISUAL}` inserted `align\}`
    // — the escape reached the document as a literal backslash before every
    // closing brace, which is precisely the case `${VISUAL}` exists for.
    const visualText = visualIsFresh ? visual!.text : '';

    /**
     * The host's answers for `${NAME}` variables.
     *
     * Read once per expansion: the values describe the document this snippet is
     * being expanded into, and asking again while a tab stop is being filled in
     * could only produce a different document's answer.
     */
    const variableValues = host.getVariables?.();
    const variables = variableValues
      ? (name: string): string | undefined => variableValues[name]
      : undefined;

    // Eukolia modification: placeholders are read with the same
    // recogniser `stripPlaceholders` uses. Nested placeholders are recursively
    // expanded into child parts, so outer and inner tab stops are both registered.
    const processPlaceholders = (
      text: string,
      startPos: vscode.Position,
      startOffset: number,
      parentPart?: HSnippetPart
    ): { endPos: vscode.Position; plainLen: number } => {
      let curPos = startPos;
      let curOffset = startOffset;
      let literalStart = 0;
      let search = 0;

      while (search < text.length) {
        const dollar = text.indexOf('$', search);
        if (dollar === -1) break;

        const token = readPlaceholder(text, dollar);
        if (!token || token.id === undefined) {
          search = dollar + 1;
          continue;
        }

        const beforeLiteral = text.substring(literalStart, dollar);
        if (beforeLiteral) {
          const stripped = stripPlaceholders(beforeLiteral, variables);
          curPos = applyOffset(curPos, stripped, indentLevel);
          curOffset += stripped.length;
        }

        const placeholderId = token.id;
        if (!this.placeholderIds.includes(placeholderId)) {
          this.placeholderIds.push(placeholderId);
        }

        const content = stripPlaceholders(token.content, variables);
        const partStartPos = curPos;
        const partEndPos = content ? endPositionFor(this.document, partStartPos, content) : partStartPos;
        const range = new DynamicRange(partStartPos, partEndPos);
        const part = new HSnippetPart(HSnippetPartType.Placeholder, range, content, placeholderId);
        part.plainOffset = curOffset;
        if (parentPart && parentPart.id !== undefined) {
          part.parentId = parentPart.id;
          if (!parentPart.children.includes(placeholderId)) {
            parentPart.children.push(placeholderId);
          }
        }
        this.parts.push(part);

        if (token.content.includes('$')) {
          processPlaceholders(token.content, partStartPos, curOffset, part);
        }

        curOffset += content.length;
        curPos = partEndPos;
        search = dollar + token.token.length;
        literalStart = search;
      }

      const trailingLiteral = text.substring(literalStart);
      if (trailingLiteral) {
        const stripped = stripPlaceholders(trailingLiteral, variables);
        curPos = applyOffset(curPos, stripped, indentLevel);
        curOffset += stripped.length;
      }

      return { endPos: curPos, plainLen: curOffset - startOffset };
    };

    for (let section of sections) {
      if (typeof section == 'string') {
        // Resolve ${VISUAL}: a selection that happens to contain
        // `$1` is text the author selected, not a substitution site. (The converse
        // — a *trigger* whose matched text contains `${VISUAL}` — is read as
        // markup, which is what typing that text into a document to be matched
        // means.)
        //
        // Eukolia modification: the reference only knew the bare `${VISUAL}`, and
        // a variable *with* a default fell through as literal text — the shipped
        // LaTeX Workshop import is full of them (`\textnormal{${1:${VISUAL:text}}}`),
        // and they arrived in the document as `${VISUAL:text}`, markup and all,
        // because the placeholder reader hands back a default verbatim and the
        // replacement above could not see inside it. The default may itself
        // contain braces (`${VISUAL:\textbf{x}}`), so the match is balanced rather
        // than `[^}]*`.
        section = replaceVisual(section, visualText);
      }

      let rawSection = section;

      if (typeof rawSection != 'string') {
        let block = blocks[rawSection.block];
        let blockStartPos = position;
        let blockStartOffset = plainSoFar.length;

        // Eukolia modification: code blocks can return snippet strings with tab stops
        // ($1, ${1:default}). Parse placeholders so they are registered as active tab stops,
        // and measure position against stripped text so document coordinates do not drift.
        const { endPos } = processPlaceholders(block, position, plainSoFar.length);
        let range = new DynamicRange(blockStartPos, endPos);

        let part = new HSnippetPart(HSnippetPartType.Block, range, block);
        part.plainOffset = blockStartOffset;
        this.parts.push(part);
        this.blockParts.push(part);

        snippetString += block;
        plainSoFar += stripPlaceholders(block, variables);
        position = endPos;
        continue;
      }

      snippetString += rawSection;

      const { endPos } = processPlaceholders(rawSection, position, plainSoFar.length);
      position = endPos;
      plainSoFar += stripPlaceholders(rawSection, variables);
    }

    this.snippetString = new vscode.SnippetString(snippetString);
    this.plainText = stripPlaceholders(this.snippetString.value, variables);
    this.currentLength = this.plainText.length;

    // The offsets recorded above were read from the plain text assembled
    // alongside the snippet string, and the two are the same string: every section
    // is resolved before it is parsed, so what the parts were laid out against is
    // what the document receives. This walk is the safety net for the day they are
    // not — the offsets are recovered by reading the plain text in part order
    // rather than left to place a tab stop somewhere the text never went.
    if (plainSoFar !== this.plainText) {
      for (const part of this.parts) {
        part.plainOffset = plainOffsetOf(this.plainText, part.content, part.plainOffset);
      }
    }

    this.range = new DynamicRange(start, position);

    this.placeholderIds = Array.from(new Set(this.placeholderIds));
    this.placeholderIds.sort((a, b) => a - b);
    if (this.placeholderIds[0] == 0) this.placeholderIds.shift();
    this.placeholderIds.push(0);
    this.selectedPlaceholder = this.placeholderIds[0];
  }

  nextPlaceholder() {
    let currentIndex = this.placeholderIds.indexOf(this.selectedPlaceholder);
    this.selectedPlaceholder = this.placeholderIds[currentIndex + 1];
    return this.selectedPlaceholder != undefined && this.selectedPlaceholder != 0;
  }

  prevPlaceholder() {
    let currentIndex = this.placeholderIds.indexOf(this.selectedPlaceholder);
    this.selectedPlaceholder = this.placeholderIds[currentIndex - 1];
    return this.selectedPlaceholder != undefined && this.selectedPlaceholder != 0;
  }

  /** Eukolia addition: the currently selected tab stop, if it is a real one. */
  selectedParts(): HSnippetPart[] {
    if (!this.selectedPlaceholder) return [];
    return this.parts.filter(
      (p) => p.type == HSnippetPartType.Placeholder && p.id == this.selectedPlaceholder
    );
  }

  /**
   * Eukolia addition: apply edits to the parts, in the expansion's own
   * coordinates.
   *
   * `changes` are document coordinates and `origin` is where the expansion
   * starts in the document, so `rangeOffset - origin` is an offset in
   * `plainText` — the same space {@link HSnippetPart.plainOffset} is measured in.
   *
   * Each part is handled on its own: an edit before it moves it, an edit inside
   * it becomes its new text, and the trailing `$0` moves with everything.
   */
  private isAncestorPart(ancestor: HSnippetPart, descendant: HSnippetPart): boolean {
    let curParentId = descendant.parentId;
    while (curParentId !== undefined) {
      if (ancestor.id !== undefined && ancestor.id === curParentId) return true;
      const parentPart = this.parts.find((p) => p.id === curParentId);
      curParentId = parentPart?.parentId;
    }
    return false;
  }

  applyEditToParts(
    changes: readonly vscode.TextDocumentContentChangeEvent[],
    origin: number
  ): HSnippetPart[] {
    const changed: HSnippetPart[] = [];
    for (const change of changes) {
      const inserted = change.text;
      const frame = inserted.length - change.rangeLength;
      const delta = change.rangeOffset - origin;
      if (delta < 0 || delta > this.currentLength) continue;

      // Find candidate parts covering delta
      const candidates = this.parts.filter(
        (p) =>
          p.type === HSnippetPartType.Placeholder &&
          p.plainOffset <= delta &&
          delta <= p.plainOffset + p.content.length
      );

      // Prioritize the currently selected tab stop
      let targetPart = candidates.find((p) => p.id === this.selectedPlaceholder);
      if (!targetPart && candidates.length > 0) {
        // Pick the innermost candidate (shortest content length)
        candidates.sort((a, b) => a.content.length - b.content.length);
        targetPart = candidates[0];
      }

      if (targetPart) {
        const targetOffset = delta - targetPart.plainOffset;
        if (targetOffset >= 0 && targetOffset <= targetPart.content.length) {
          const replaceLen = Math.min(change.rangeLength, targetPart.content.length - targetOffset);
          targetPart.content =
            targetPart.content.slice(0, targetOffset) +
            inserted +
            targetPart.content.slice(targetOffset + replaceLen);
        }
        changed.push(targetPart);

        // Invalidate child placeholders if parent was directly edited
        if (targetPart.children && targetPart.children.length > 0) {
          const dropIds = new Set<number>();
          const collectDescendants = (p: HSnippetPart) => {
            for (const childId of p.children ?? []) {
              dropIds.add(childId);
              const childPart = this.parts.find((cp) => cp.id === childId);
              if (childPart) collectDescendants(childPart);
            }
          };
          collectDescendants(targetPart);
          targetPart.children = [];
          this.placeholderIds = this.placeholderIds.filter((id) => !dropIds.has(id));
          this.parts = this.parts.filter((p) => p.id === undefined || !dropIds.has(p.id));
        }

        // Update ancestor chain
        let curParentId = targetPart.parentId;
        while (curParentId !== undefined) {
          const parentPart = this.parts.find((p) => p.id === curParentId);
          if (!parentPart) break;
          const parentOffset = delta - parentPart.plainOffset;
          if (parentOffset >= 0 && parentOffset <= parentPart.content.length) {
            const replaceLen = Math.min(
              change.rangeLength,
              parentPart.content.length - parentOffset
            );
            parentPart.content =
              parentPart.content.slice(0, parentOffset) +
              inserted +
              parentPart.content.slice(parentOffset + replaceLen);
          }
          changed.push(parentPart);
          curParentId = parentPart.parentId;
        }

        // Mirror occurrences of the same placeholder ID
        for (const mirror of this.parts) {
          if (mirror === targetPart || mirror.type !== HSnippetPartType.Placeholder) continue;
          if (mirror.id === targetPart.id) {
            mirror.content = targetPart.content;
            changed.push(mirror);
          }
        }

        // Shift offsets for following parts
        const targetIndex = this.parts.indexOf(targetPart);
        for (let i = 0; i < this.parts.length; i++) {
          const part = this.parts[i];
          if (part === targetPart || this.isAncestorPart(part, targetPart)) continue;
          if (part.plainOffset > delta || (part.plainOffset === delta && i > targetIndex)) {
            part.plainOffset += frame;
          }
        }
      } else {
        // No placeholder took the edit; shift all parts at or after delta
        for (const part of this.parts) {
          if (part.plainOffset >= delta) {
            part.plainOffset += frame;
          }
        }
      }

      this.currentLength += frame;
      if (this.currentLength < 0) this.currentLength = 0;
    }

    // The instance's own range is realigned with what was just maintained.
    const offsetAt = this.document.offsetAt?.bind(this.document);
    const positionAt = this.document.positionAt?.bind(this.document);
    if (offsetAt && positionAt && this.currentLength > 0) {
      const start = this.range.range.start;
      const startOffset = offsetAt(start);
      this.range.set(new vscode.Range(start, positionAt(startOffset + this.currentLength)));
    }

    return changed;
  }

  debugLog() {
    let parts = this.parts;
    for (let i = 0; i < parts.length; i++) {
      let range = parts[i].range.range;
      let start = range.start;
      let end = range.end;
      console.log(
        `Tabstop ${i}: "${parts[i].content}" (${start.line}, ${start.character})..(${end.line}, ${end.character})`
      );
    }
  }

  // Updates the location of all the placeholder blocks and code blocks, and if any change happened
  // to the placeholder blocks then run the generator function again with the updated values so the
  // code blocks are updated.
  //
  // Eukolia modification: `changeOrigin` is where the expansion begins in the
  // document the changes are expressed in, which is what turns a document offset
  // into an offset in this expansion's own text. It is optional so the reference
  // call shape still works; without it the parts keep the values the assembly
  // gave them and only the ranges are translated.
  update(changes: readonly vscode.TextDocumentContentChangeEvent[], changeOrigin?: number) {
    let ordChanges = [...changes];
    ordChanges.sort((a, b) => {
      if (a.range.end.isBefore(b.range.end)) return -1;
      else if (a.range.end.isEqual(b.range.end)) return 0;
      else return 1;
    });

    let changedPlaceholders: HSnippetPart[] = [];
    let currentPart = 0;

    // Eukolia modification: the reference indexed `this.parts` unconditionally,
    // which throws for an expansion that produced no parts (a snippet whose body
    // is a single code block, for instance). Bail out instead.
    if (!this.parts.length) {
      this.range.update(ordChanges.map((c) => ({ change: c, growth: GrowthType.Grow })));
      return;
    }

    // Expand ranges from left to right, preserving relative part positions.
    for (let change of ordChanges) {
      if (!change) continue;
      let part = this.parts[currentPart];

      while (currentPart < this.parts.length) {
        if (part.range.range.end.isAfterOrEqual(change.range.end)) {
          break;
        }

        currentPart++;
        part = this.parts[currentPart];
      }

      if (currentPart >= this.parts.length) break;

      while (part && part.range.contains(change.range)) {
        if (
          (part.type == HSnippetPartType.Placeholder &&
            part.id == this.selectedPlaceholder &&
            !this.blockChanged) ||
          (part.type == HSnippetPartType.Block && this.blockChanged && part.content == change.text)
        ) {
          if (part.type == HSnippetPartType.Placeholder) {
            changedPlaceholders.push(part);
            let curParentId = part.parentId;
            while (curParentId !== undefined) {
              const parentPart = this.parts.find((p) => p.id === curParentId);
              if (parentPart) {
                parentPart.updates.push({ change, growth: GrowthType.Grow });
                curParentId = parentPart.parentId;
              } else {
                break;
              }
            }
          }
          part.updates.push({ change, growth: GrowthType.Grow });
          currentPart++;
          part = this.parts[currentPart];
          break;
        }

        currentPart++;
        part = this.parts[currentPart];
      }

      for (let i = currentPart; i < this.parts.length; i++) {
        this.parts[i].updates.push({ change, growth: GrowthType.FixRight });
      }
    }

    this.range.update(ordChanges.map((c) => ({ change: c, growth: GrowthType.Grow })));
    this.parts.forEach((p) => p.updateRange());

    // Eukolia modification: the placeholder values are maintained here rather
    // than read back out of the document.
    //
    // Reading them back needs a position for every part, and the ranges above are
    // an unreliable source for one: the loop only grows the placeholder the caret
    // is in — the reference's guard, which stops a code block regenerating itself
    // from looking like typing — so a placeholder filled earlier keeps the end it
    // had before, and a part whose range was never grown reports a position that
    // no longer holds what it holds. Tab then lands beside the next tab stop
    // instead of on it, and a code block reads a neighbouring character as its
    // input.
    //
    // The expansion's own text cannot drift: it is fixed when the snippet is
    // built and every part knows where it sits in it. Applying the edit to those
    // coordinates is therefore exact, and the parts it reports as changed are
    // what the code-block regeneration below re-runs the generator with.
    if (changeOrigin !== undefined) {
      for (const part of this.applyEditToParts(ordChanges, changeOrigin)) {
        if (!changedPlaceholders.includes(part)) changedPlaceholders.push(part);
      }
    }

    if (this.blockChanged) this.blockChanged = false;
    if (!changedPlaceholders.length) return;

    let placeholderContents = this.parts
      .filter((p) => p.type == HSnippetPartType.Placeholder)
      .map((p) => p.content);

    let blocks: string[];
    try {
      blocks = this.type.generator(
        undefined,
        placeholderContents,
        this.matchGroups,
        this.workspaceUri,
        documentUri(this.document)
      )[1].map(String);
    } catch (e) {
      // A code block that throws must not escape into the keystroke that ran it.
      // This is called from the editor's change handler — through
      // `SnippetEngine.applyExpansionEdit` from a CodeMirror update listener — and
      // an exception there is thrown out of the editor's own update, which leaves
      // the view mid-update and the key unprevented. The constructor already
      // reports the same failure this way; the re-run used to be the one path
      // where an author's mistake took the editor with it. The tab stops below
      // are updated by then, so the expansion stays usable and only the code
      // blocks keep the text they had.
      if (e instanceof Error) {
        const message = `Snippet ${this.type.description} failed to update with error: ${e.message}`;
        if (host.warn) host.warn(message);
        else console.warn(message);
      }
      return;
    }

    const editor = this.editor;
    if (!editor) {
      this.blockParts.forEach((b, i) => (b.content = blocks[i] ?? b.content));
      return;
    }

    editor.edit((edit) => {
      // Bounded by the expansion's own parts: the generator is asked for one
      // result per code block, and a body that returns a different number must
      // not index past them.
      const count = Math.min(blocks.length, this.blockParts.length);
      for (let i = 0; i < count; i++) {
        let range = this.blockParts[i].range;
        let oldContent = this.blockParts[i].content;
        let content = blocks[i] ?? oldContent;

        if (content != oldContent) {
          edit.replace(range.range, content);
          this.blockChanged = true;
        }
      }
    });

    this.blockParts.forEach((b, i) => (b.content = blocks[i] ?? b.content));
  }
}

/**
 * Eukolia addition: resolve VS Code snippet markup (`$1`, `${VISUAL}`,
 * `${1:default}`, `${1|a,b|}`) down to the literal text that would be inserted.
 * The reference delegated this to VS Code's snippet controller.
 *
 * Only `\$` is an escape (a literal dollar sign). A backslash-anything-else —
 * overwhelmingly `\\`, LaTeX's row separator, and `\{` / `\}` — is passed through
 * untouched; consuming `\\` here would silently halve every LaTeX line break.
 *
 * A token's own text is resolved the same way, which is what makes a placeholder
 * that contains another one render as the inner text rather than as its markup:
 * `${1:${2:inner}}` is `inner`, not `${2:inner}`. The markup used to survive into
 * the document for every nested form — a variable inside a default
 * (`${1:${TM_FILENAME}}`) put the literal `${TM_FILENAME}` in the buffer.
 *
 * `variable` answers a `${NAME}` / `${NAME:default}` token; without one (or for a
 * name it does not know) the token's default is used, which is the reference's
 * behaviour for a variable the editor could not resolve.
 */
export function stripPlaceholders(
  text: string,
  variable?: (name: string) => string | undefined
): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];

    if (char === BACKSLASH && i + 1 < text.length) {
      if (text[i + 1] === '$') {
        result += '$';
        i += 2;
        continue;
      }
      if (text[i + 1] === '}') {
        result += '}';
        i += 2;
        continue;
      }
      result += BACKSLASH;
      i++;
      continue;
    }

    if (char === '$') {
      // Eukolia modification: the same reader the constructor uses, so the text
      // that is inserted and the tab stops that are created cannot disagree.
      const token = readPlaceholder(text, i);
      if (token) {
        const name = token.id === undefined ? variableName(token.token) : null;
        const resolved = name === null ? undefined : variable?.(name);
        result += resolved !== undefined ? resolved : stripPlaceholders(token.content, variable);
        i += token.token.length;
        continue;
      }
    }

    result += char;
    i++;
  }
  return result;
}

/** The name of a `${NAME}` / `${NAME:default}` token, or `null` for any other. */
function variableName(token: string): string | null {
  const match = /^\$\{([A-Za-z_][\w]*)/.exec(token);
  return match ? match[1] : null;
}
