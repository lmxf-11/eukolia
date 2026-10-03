/**
 * Shared shapes for LaTeX document analysis.
 *
 * Kept in a dependency-free module so the document model, the outline, the
 * completion providers and the visual editor can all agree on the shape without
 * importing a particular parser implementation.
 */

export interface OutlineItem {
  /** Nesting depth: 0 for `\part`/`\chapter`, increasing down to `\subparagraph`. */
  readonly level: number;
  readonly title: string;
  /** Character offset of the sectioning command in the source. */
  readonly offset: number;
  /** 1-based line number. */
  readonly line: number;
  /** `\label` names attached to this section, in source order. */
  readonly labels: readonly string[];
  readonly children: readonly OutlineItem[];
  /** The command that produced the item, e.g. `section` (without the backslash). */
  readonly command: string;
  /** Starred variants (`\section*{}`) are marked so the outline can style them. */
  readonly starred: boolean;
}

export interface LabelInfo {
  readonly name: string;
  readonly offset: number;
  readonly line: number;
  /** Enclosing environment, when known. */
  readonly environment?: string;
}

export interface CitationInfo {
  readonly keys: readonly string[];
  readonly offset: number;
  readonly line: number;
  readonly command: string;
}

export interface MacroDefinitionInfo {
  readonly name: string;
  /** Number of arguments the macro takes, when the definition states it. */
  readonly args: number;
  readonly offset: number;
  readonly line: number;
  /** The full source text of the definition. */
  readonly definition: string;
  /** True for `\def`/`\let`-style TeX primitives rather than `\newcommand`. */
  readonly primitive: boolean;
}

export interface EnvironmentInfo {
  readonly name: string;
  readonly beginOffset: number;
  readonly beginLine: number;
  readonly endOffset: number | null;
  readonly endLine: number | null;
  /** True when this environment is inside another environment. */
  readonly nested: boolean;
}

export interface IncludedFileInfo {
  /** The raw argument as written in the source. */
  readonly path: string;
  readonly offset: number;
  readonly line: number;
  /** `input`, `include`, `subfile`, `import`, `subimport`, `includegraphics`, `bibliography`, `addbibresource`. */
  readonly command: string;
}

export interface SectioningInfo {
  readonly level: number;
  readonly title: string;
  readonly offset: number;
  readonly line: number;
  readonly command: string;
  readonly starred: boolean;
}

/** Ordering of sectioning commands from coarsest to finest. */
export const SECTIONING_ORDER = [
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph'
] as const;

export type SectioningCommand = (typeof SECTIONING_ORDER)[number];

export function sectioningLevel(command: string): number | null {
  const index = (SECTIONING_ORDER as readonly string[]).indexOf(command);
  return index === -1 ? null : index;
}
