/**
 * Eukolia completion framework.
 *
 * Completion is composed from independent sources rather than one monolithic
 * provider: the ported LaTeX Workshop data providers, the project index
 * (labels, citations, macros, files) and the HyperSnips snippet engine all
 * register here, and the editor adapter queries them together.
 *
 * This keeps "add a completion kind" a one-file change and lets sources be
 * tested in isolation.
 */

import { projectIndex } from '../document/projectIndex';

export interface CompletingArgument {
  /** Command name without the backslash, e.g. `cite`. */
  name: string;
  /** Which argument the caret is in: 1 for the first `{}` group. */
  argumentIndex: number;
  /** Offset of the opening brace. */
  from: number;
  /** Offset just past the closing brace. */
  to: number;
}

export interface CompletionContext {
  text: string;
  offset: number;
  uri: string;
  languageId: string;
  /** 1-based line number. */
  lineNumber: number;
  /** 1-based column. */
  column: number;
  /** The full text of the caret's line. */
  lineText: string;
  /** The partial word before the caret. */
  prefix: string;
  /** True when the caret follows a `\`. */
  afterBackslash: boolean;
  /** The command whose argument the caret is in, if any. */
  argument: CompletingArgument | null;
  /** Innermost `\begin{...}` environment, if any. */
  environment: string | null;
  inMath: boolean;
  triggerCharacter?: string;
}

export type CompletionKind =
  | 'command'
  | 'environment'
  | 'package'
  | 'class'
  | 'citation'
  | 'reference'
  | 'label'
  | 'file'
  | 'macro'
  | 'snippet'
  | 'symbol'
  | 'word';

export interface CompletionEntry {
  label: string;
  kind: CompletionKind;
  insertText: string;
  /** `snippet` enables `${1:placeholder}` syntax in `insertText`. */
  insertTextFormat?: 'plain' | 'snippet';
  detail?: string;
  documentation?: string;
  /** The source that produced this entry, for diagnostics and ranking. */
  source: string;
  sortText?: string;
  filterText?: string;
  /** Explicit replacement range; defaults to the current word. */
  range?: { from: number; to: number };
}

export interface CompletionSource {
  readonly id: string;
  /** Lower runs first among equals. */
  readonly priority?: number;
  provide(context: CompletionContext): CompletionEntry[] | Promise<CompletionEntry[]>;
}

const ROLE_TO_KIND: Record<string, CompletionKind> = {
  label: 'label',
  reference: 'reference',
  citation: 'citation',
  file: 'file',
  package: 'package',
  class: 'class',
  environment: 'environment'
};

/**
 * Works out what the caret is inside: a command argument, an environment, math
 * mode, and the partial word being typed.
 */
export function analyzeCompletionContext(
  text: string,
  offset: number,
  uri: string,
  languageId = 'latex'
): CompletionContext {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, safeOffset);

  const lineStart = before.lastIndexOf('\n') + 1;
  const lineText = text.slice(lineStart, text.indexOf('\n', safeOffset) === -1 ? text.length : text.indexOf('\n', safeOffset));
  const column = safeOffset - lineStart + 1;
  const lineNumber = before.split('\n').length;

  const prefixMatch = /[\\{]?[A-Za-z0-9_*:./-]*$/.exec(before);
  const prefix = prefixMatch ? prefixMatch[0] : '';
  const afterBackslash = prefix.startsWith('\\');

  return {
    text,
    offset: safeOffset,
    uri,
    languageId,
    lineNumber,
    column,
    lineText,
    prefix,
    afterBackslash,
    argument: findEnclosingArgument(text, safeOffset),
    environment: findEnclosingEnvironment(text, safeOffset),
    inMath: isInsideMath(text, safeOffset)
  };
}

/**
 * Finds the `\command{...}` whose braces contain `offset`.
 *
 * Scans forward from the start of the document keeping a brace stack, so nested
 * groups resolve to the innermost command that actually owns the caret. Escaped
 * braces (`\{`) and comment text are skipped, since neither affects grouping.
 */
export function findEnclosingArgument(text: string, offset: number): CompletingArgument | null {
  const openIndex = findEnclosingOpenBrace(text, offset);
  if (openIndex === -1) return null;

  const command = commandBeforeBrace(text, openIndex);
  if (!command) return null;

  const close = findMatchingBrace(text, openIndex);
  return {
    name: command.name,
    argumentIndex: countPrecedingArguments(text, command.start, openIndex),
    from: openIndex,
    to: close === -1 ? text.length : close + 1
  };
}

/** Index of the innermost unclosed `{` before `offset`, or -1. */
function findEnclosingOpenBrace(text: string, offset: number): number {
  const stack: number[] = [];
  for (let i = 0; i < offset; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++; // an escaped character never opens or closes a group
      continue;
    }
    if (ch === '%') {
      const newline = text.indexOf('\n', i);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    if (ch === '{') stack.push(i);
    else if (ch === '}') stack.pop();
  }
  return stack.length > 0 ? stack[stack.length - 1] : -1;
}

/** Parses the `\name` that owns the group opening at `braceIndex`, if any. */
function commandBeforeBrace(text: string, braceIndex: number): { name: string; start: number } | null {
  let cursor = braceIndex - 1;

  const skipWhitespace = () => {
    while (cursor >= 0 && /\s/.test(text[cursor])) cursor--;
  };

  skipWhitespace();

  // Step back over any optional `[...]` groups, then over their whitespace.
  while (cursor >= 0 && text[cursor] === ']') {
    let depth = 1;
    cursor--;
    while (cursor >= 0 && depth > 0) {
      if (text[cursor] === ']') depth++;
      else if (text[cursor] === '[') depth--;
      cursor--;
    }
    skipWhitespace();
  }

  const end = cursor + 1;
  const match = /([A-Za-z@]+)\*?$/.exec(text.slice(0, end));
  if (!match) return null;

  const nameStart = end - match[0].length;
  if (nameStart <= 0 || text[nameStart - 1] !== '\\') return null;
  return { name: match[1], start: nameStart - 1 };
}

/** Finds the `}` matching the `{` at `openIndex`, or -1. */
function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '%') {
      const newline = text.indexOf('\n', i);
      if (newline === -1) return -1;
      i = newline;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Which argument the group at `braceIndex` is: 1 for the first `{}` after the
 * command name, 2 for the second, and so on. Optional `[...]` groups do not
 * count, matching how LaTeX arguments are usually described.
 */
function countPrecedingArguments(text: string, commandStart: number, braceIndex: number): number {
  let count = 0;
  let i = commandStart;

  if (text[i] === '\\') i++;
  while (i < text.length && /[A-Za-z@*]/.test(text[i])) i++;

  while (i < braceIndex) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '[') {
      let depth = 1;
      i++;
      while (i < braceIndex && depth > 0) {
        if (text[i] === '[') depth++;
        else if (text[i] === ']') depth--;
        i++;
      }
      continue;
    }
    if (ch === '{') {
      const close = findMatchingBrace(text, i);
      if (close === -1 || close >= braceIndex) break;
      count++;
      i = close + 1;
      continue;
    }
    i++;
  }

  return count + 1;
}

/** Innermost enclosing `\begin{...}` whose `\end` has not been reached. */
export function findEnclosingEnvironment(text: string, offset: number): string | null {
  const stack: string[] = [];
  const regexp = /\\(begin|end)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = regexp.exec(text)) !== null) {
    if (match.index >= offset) break;
    if (match[1] === 'begin') stack.push(match[2]);
    else {
      const index = stack.lastIndexOf(match[2]);
      if (index !== -1) stack.splice(index, 1);
    }
  }
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

/**
 * Best-effort detection of whether `offset` sits in mathematics.
 * Handles `$...$`, `$$...$$`, `\(...\)`, `\[...\]` and math environments.
 */
export function isInsideMath(text: string, offset: number): boolean {
  const before = text.slice(0, offset);
  const environment = findEnclosingEnvironment(text, offset);
  if (environment) {
    const mathEnvironments = new Set([
      'math',
      'displaymath',
      'equation',
      'equation*',
      'align',
      'align*',
      'aligned',
      'alignedat',
      'gather',
      'gather*',
      'multline',
      'multline*',
      'flalign',
      'flalign*',
      'alignat',
      'split',
      'cases',
      'matrix',
      'pmatrix',
      'bmatrix',
      'Bmatrix',
      'vmatrix',
      'Vmatrix',
      'smallmatrix'
    ]);
    if (mathEnvironments.has(environment)) return true;
  }

  // Strip escaped dollars so `\$` does not toggle math mode.
  const unescaped = before.replace(/\\\$/g, '').replace(/\$\$/g, '\u0000');
  const singleDollars = (unescaped.match(/\$/g) ?? []).length;
  if (singleDollars % 2 === 1) return true;
  if ((unescaped.match(/\u0000/g) ?? []).length % 2 === 1) return true;

  const openParen = (before.match(/\\\(/g) ?? []).length;
  const closeParen = (before.match(/\\\)/g) ?? []).length;
  if (openParen > closeParen) return true;

  const openBracket = (before.match(/\\\[/g) ?? []).length;
  const closeBracket = (before.match(/\\\]/g) ?? []).length;
  return openBracket > closeBracket;
}

/** The completion kind a command's argument implies. */
export function argumentKind(commandName: string): CompletionKind | null {
  // Imported lazily to avoid a cycle with latexLanguage.
  const roles: Record<string, CompletionKind> = {
    label: 'label',
    ref: 'reference',
    eqref: 'reference',
    pageref: 'reference',
    autoref: 'reference',
    nameref: 'reference',
    cref: 'reference',
    Cref: 'reference',
    vref: 'reference',
    cite: 'citation',
    Cite: 'citation',
    citep: 'citation',
    citet: 'citation',
    autocite: 'citation',
    parencite: 'citation',
    textcite: 'citation',
    footcite: 'citation',
    nocite: 'citation',
    input: 'file',
    include: 'file',
    includeonly: 'file',
    subfile: 'file',
    import: 'file',
    subimport: 'file',
    bibliographies: 'file',
    addbibresource: 'file',
    bibliography: 'file',
    includegraphics: 'file',
    usepackage: 'package',
    RequirePackage: 'package',
    documentclass: 'class',
    LoadClass: 'class'
  };
  return roles[commandName] ?? null;
}

export { ROLE_TO_KIND };

/**
 * Collects and de-duplicates entries from every registered source.
 * Later sources do not override earlier ones for the same label within the same
 * kind, so a project label always beats a generic suggestion.
 */
export class CompletionRegistry {
  private readonly sources: CompletionSource[] = [];
  private readonly extraSources = new Map<string, CompletionSource>();

  public register(source: CompletionSource): () => void {
    this.extraSources.set(source.id, source);
    this.rebuild();
    return () => {
      this.extraSources.delete(source.id);
      this.rebuild();
    };
  }

  public unregister(id: string): void {
    this.extraSources.delete(id);
    this.rebuild();
  }

  private rebuild(): void {
    this.sources.length = 0;
    this.sources.push(...this.extraSources.values());
    this.sources.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  public getSources(): readonly CompletionSource[] {
    return this.sources;
  }

  public async provide(context: CompletionContext, options: { limit?: number } = {}): Promise<CompletionEntry[]> {
    const limit = options.limit ?? 200;
    const results = await Promise.all(
      this.sources.map(async (source) => {
        try {
          return await source.provide(context);
        } catch (err) {
          console.error(`[eukolia] completion source "${source.id}" failed`, err);
          return [] as CompletionEntry[];
        }
      })
    );

    const seen = new Set<string>();
    const merged: CompletionEntry[] = [];
    for (const entries of results) {
      for (const entry of entries) {
        const key = `${entry.kind}\u0000${entry.label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(entry);
        if (merged.length >= limit * 3) break;
      }
    }
    return merged.slice(0, limit);
  }
}

export const completionRegistry = new CompletionRegistry();

// ---------------------------------------------------------------------------
// Built-in sources backed by the project index
// ---------------------------------------------------------------------------

/** Labels defined in the project: `\ref{...}`, `\eqref{...}`, `\cref{...}`. */
export const projectLabelSource: CompletionSource = {
  id: 'project-labels',
  priority: 90,
  provide(context) {
    const kind = context.argument ? argumentKind(context.argument.name) : null;
    if (kind !== 'label' && kind !== 'reference') return [];
    return projectIndex.getLabels().map((label) => ({
      label: label.name,
      kind,
      insertText: label.name,
      detail: `label in ${label.file.split(/[\\/]/).pop()}:${label.line}`,
      source: 'project-labels',
      sortText: `0${label.name}`
    }));
  }
};

/** Citation keys from every `.bib` file in the project. */
export const projectCitationSource: CompletionSource = {
  id: 'project-citations',
  priority: 90,
  provide(context) {
    if (context.argument && argumentKind(context.argument.name) !== 'citation') return [];
    // Present already-cited keys first, then the rest of the bibliography.
    const cited = new Set(projectIndex.getCitedKeys());
    return projectIndex.getBibEntries().map((entry) => ({
      label: entry.key,
      kind: 'citation' as const,
      insertText: entry.key,
      detail: [entry.authors?.slice(0, 2).join(', '), entry.year, entry.title].filter(Boolean).join(' · '),
      documentation: entry.fields.abstract,
      source: 'project-citations',
      sortText: `${cited.has(entry.key) ? '0' : '1'}${entry.key}`
    }));
  }
};

/** Macros defined in the project (`\newcommand`, `\def`, package macros). */
export const projectMacroSource: CompletionSource = {
  id: 'project-macros',
  priority: 80,
  provide(context) {
    if (!context.afterBackslash) return [];
    const typed = context.prefix.replace(/^\\/, '');
    return projectIndex
      .getMacros()
      .filter((macro) => !typed || macro.name.startsWith(typed))
      .map((macro) => ({
        label: `\\${macro.name}`,
        kind: 'macro' as const,
        insertText: macro.args > 0 ? `\\${macro.name}{$${Array.from({ length: macro.args }, (_, i) => `{${i + 1}}`).join('')}}` : `\\${macro.name}`,
        insertTextFormat: 'snippet' as const,
        detail: macro.args > 0 ? `macro with ${macro.args} argument${macro.args === 1 ? '' : 's'}` : 'macro',
        documentation: macro.definition,
        source: 'project-macros',
        sortText: `1${macro.name}`
      }));
  }
};

/** Environment names used in the project, for `\begin{` / `\end{` and `\end{...}` pairing. */
export const projectEnvironmentSource: CompletionSource = {
  id: 'project-environments',
  priority: 85,
  provide(context) {
    const before = context.text.slice(Math.max(0, context.offset - 40), context.offset);
    const typingBegin = /\\begin\{[^}]*$/.test(before);
    const typingEnd = /\\end\{[^}]*$/.test(before);
    if (!typingBegin && !typingEnd) return [];

    const openStack = typingEnd ? collectOpenEnvironments(context.text, context.offset) : [];
    const names = typingEnd && openStack.length > 0 ? openStack : projectIndex.getEnvironmentNames();

    const typed = /[^\\{]*$/.exec(context.prefix.replace(/^\\/, ''))?.[0] ?? '';
    return names
      .filter((name) => !typed || name.startsWith(typed))
      .filter((name, index) => names.indexOf(name) === index)
      .map((name, index) => ({
        label: name,
        kind: 'environment' as const,
        insertText: name,
        detail: typingEnd ? 'close the innermost open environment' : 'environment',
        source: 'project-environments',
        // Innermost unclosed environment first when closing.
        sortText: `${index.toString().padStart(4, '0')}${name}`
      }));
  }
};

/** Files in the project, for `\input{}`, `\include{}`, `\includegraphics{}`. */
export const projectFileSource: CompletionSource = {
  id: 'project-files',
  priority: 85,
  provide(context) {
    const kind = context.argument ? argumentKind(context.argument.name) : null;
    if (kind !== 'file') return [];

    const isGraphics = context.argument?.name === 'includegraphics';
    const extensions = isGraphics ? ['pdf', 'png', 'jpg', 'jpeg', 'eps', 'svg'] : ['tex', 'ltx', 'sty', 'bib'];
    const typed = context.prefix.replace(/^[\\{]/, '');

    const files = projectIndex.getFiles().filter((file) => {
      if (file.isDirectory) return false;
      if (!extensions.some((ext) => file.name.toLowerCase().endsWith(`.${ext}`))) return false;
      if (!typed) return true;
      const normalized = typed.replace(/\\/g, '/').toLowerCase();
      return file.relativePath.replace(/\\/g, '/').toLowerCase().includes(normalized);
    });

    const root = projectIndex.getProjectRoot();
    return files.slice(0, 300).map((file) => {
      // Without an extension is the LaTeX convention for \input.
      const withoutExtension = file.relativePath.replace(/\.[^.]*$/, '');
      const text = isGraphics ? file.relativePath : withoutExtension;
      return {
        label: file.relativePath.replace(/\\/g, '/'),
        kind: 'file' as const,
        insertText: text.replace(/\\/g, '/'),
        detail: root ? 'project file' : file.path,
        source: 'project-files',
        sortText: `2${file.relativePath}`
      };
    });
  }
};

/** Words already present in the document, as a last-resort fallback. */
export const documentWordSource: CompletionSource = {
  id: 'document-words',
  priority: 1,
  provide(context) {
    if (context.prefix.length < 3 || context.afterBackslash) return [];
    const word = context.prefix;
    const counts = new Map<string, number>();
    const regexp = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*`, 'g');
    let match: RegExpExecArray | null;
    while ((match = regexp.exec(context.text)) !== null) {
      if (match.index === context.offset - word.length) continue;
      counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([text, count]) => ({
        label: text,
        kind: 'word' as const,
        insertText: text,
        detail: `${count} occurrence${count === 1 ? '' : 's'}`,
        source: 'document-words',
        sortText: `9${text}`
      }));
  }
};

/** Names of the environments currently open at `offset`, innermost first. */
export function collectOpenEnvironments(text: string, offset: number): string[] {
  const stack: string[] = [];
  const regexp = /\\(begin|end)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regexp.exec(text)) !== null) {
    if (match.index >= offset) break;
    if (match[1] === 'begin') stack.push(match[2]);
    else {
      const index = stack.lastIndexOf(match[2]);
      if (index !== -1) stack.splice(index, 1);
    }
  }
  return stack.reverse();
}

completionRegistry.register(projectLabelSource);
completionRegistry.register(projectCitationSource);
completionRegistry.register(projectEnvironmentSource);
completionRegistry.register(projectFileSource);
completionRegistry.register(projectMacroSource);
completionRegistry.register(documentWordSource);
