/**
 * Eukolia Snippet Engine — editor-agnostic context provider.
 *
 * The HyperSnips reference decided math-mode availability inline in
 * `extension.ts` (`isMathEnvironment`). Eukolia exposes the same answer through
 * a pluggable provider so the engine can be fed by Eukolia's own LaTeX parser
 * instead of by the regular-expression heuristic, while the heuristic stays
 * available as the default.
 *
 * Ported from References/hypersnips/src/extension.ts (MIT, (c) 2019 Ian Ornelas).
 * Modified for Eukolia.
 */

import * as vscode from 'vscode';
import {
  getLineContext,
  getMultiLineContextText,
  getTriggerContext,
  isMathEnvironmentText
} from '../vendor/hypersnips/contextDetector';
import { getMultiLineContext } from '../vendor/hypersnips/completion';

/** Structural view of the document a snippet decision is being made in. */
export interface ContextDocument {
  getText(range?: vscode.Range): string;
  lineCount?: number;
  languageId?: string;
  uri?: { toString(): string; fsPath?: string; path?: string };
  isMathAt?(offset: number): boolean;
}

export interface LatexContext {
  /** Whether the offset sits in math mode. */
  isMath: boolean;
  /** Environment the offset sits in, when the detector can tell. */
  environment?: string;
  /** Inclusive `\begin{...}` line, when known. */
  environmentStartLine?: number;
  /** Math delimiter that opened the current math region (`$`, `$$`, `\(`, `\[`). */
  mathDelimiter?: string;
  /** Detector provenance, useful for diagnostics. */
  source?: string;
}

export interface ContextDetector {
  isMath(): boolean;
  getEnvironment(): string | undefined;
  /** Token the cursor follows, matched against non-regex triggers. */
  getTriggerContext(): string;
  /** Current line up to the cursor, matched against single-line regex triggers. */
  getLineContext(): string;
  /** `hsnips.multiLineContext` previous lines plus the current prefix. */
  getMultiLineContext(): string;
}

export interface ContextDetectorInput {
  doc: ContextDocument;
  offset: number;
  languageId: string;
  /** Optional trigger character reported by the editor. */
  triggerCharacter?: string;
}

export interface ContextProvider {
  /** Produce a detector for one decision point. */
  createDetector(input: ContextDetectorInput): ContextDetector;
  /** Optional richer answer; when absent `createDetector().isMath()` is used. */
  getLatexContext?(input: ContextDetectorInput): LatexContext;
}

/** Detector built purely on text snapshots — no editor and no LaTeX parser. */
export class TextContextDetector implements ContextDetector {
  protected readonly snapshot: { text: string; offset: number };

  constructor(
    text: string,
    offset: number,
    protected readonly multiLineLines: number
  ) {
    this.snapshot = { text, offset: Math.max(0, Math.min(offset, text.length)) };
  }

  isMath(): boolean {
    return isMathEnvironmentText(this.snapshot.text.slice(0, this.snapshot.offset));
  }

  getEnvironment(): string | undefined {
    return undefined;
  }

  getTriggerContext(): string {
    return getTriggerContext(this.snapshot);
  }

  getLineContext(): string {
    return getLineContext(this.snapshot);
  }

  getMultiLineContext(): string {
    return getMultiLineContextText(this.snapshot, this.multiLineLines);
  }
}

/**
 * Default provider: the reference's own heuristic, applied to a snapshot of the
 * document taken at the decision point.
 */
export class TextContextProvider implements ContextProvider {
  constructor(private readonly options: { multiLineContext?: () => number } = {}) {}

  createDetector(input: ContextDetectorInput): ContextDetector {
    const lines = this.options.multiLineContext?.() ?? getMultiLineContext();
    return new TextViewContextDetector(input.doc, input.offset, lines);
  }

  getLatexContext(input: ContextDetectorInput): LatexContext {
    const detector = this.createDetector(input);
    return { isMath: detector.isMath(), source: 'snippet-math-scanner' };
  }
}

/**
 * `TextContextDetector` bound to a document: reads text directly so callers do
 * not have to materialise the whole document themselves.
 */
export class TextViewContextDetector extends TextContextDetector {
  constructor(
    private readonly doc: ContextDocument,
    offset: number,
    multiLineLines: number
  ) {
    super(readDocumentText(doc), offset, multiLineLines);
  }

  override isMath(): boolean {
    if (typeof this.doc.isMathAt === 'function') {
      try {
        if (this.doc.isMathAt(this.snapshot.offset)) return true;
      } catch {
        /* fall through to text heuristic */
      }
    }
    return super.isMath();
  }
}

function readDocumentText(doc: ContextDocument): string {
  try {
    return doc.getText();
  } catch {
    return '';
  }
}

let activeProvider: ContextProvider = new TextContextProvider();

export function setContextProvider(provider: ContextProvider | null): void {
  activeProvider = provider ?? new TextContextProvider();
}

export function getContextProvider(): ContextProvider {
  return activeProvider;
}

/**
 * Convenience used by the engine's completion filters: resolves the snippet's
 * `m` (math) / `n` (non-math) flags against the active provider.
 */
export function snippetContextAllows(
  snippet: { math: boolean; nonmath: boolean },
  input: ContextDetectorInput
): boolean {
  if (!snippet.math && !snippet.nonmath) return true;
  const inMath = activeProvider.createDetector(input).isMath();
  if (snippet.math && !inMath) return false;
  if (snippet.nonmath && inMath) return false;
  return true;
}
